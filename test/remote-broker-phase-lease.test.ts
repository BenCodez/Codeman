/** Actual broker + disposable Python child; no tmux, SSH, CLI or manager effects. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  CodexInputBroker,
  type BrokerConfig,
  type BrokerRemoteIssuerLease,
} from '../src/recovery/codex-input-broker.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MANAGER = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const CID = '11111111-2222-3333-4444-555555555555';
const OWNERS = { 'owner-pty': 0, 'owner-key': 0, 'owner-mux': 0 };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
const running: Array<{ process: ChildProcessWithoutNullStreams; root: string; done: Promise<void> }> = [];
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 2500;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Fake broker did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function fixture(startup?: (config: BrokerConfig) => void, helper?: (source: string) => string) {
  const root = await fs.mkdtemp(join(homedir(), 'remote-phase-fixture-'));
  const childPath = join(root, 'fake-child.py');
  await fs.writeFile(
    childPath,
    String.raw`import os,select,sys,termios,tty
tty.setraw(0,termios.TCSANOW)
root=sys.argv[1]
open(os.path.join(root,'started'),'w').close()
fd=os.open(os.path.join(root,'bytes'),os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
while not os.path.exists(os.path.join(root,'stop')):
 if select.select([0],[],[],.01)[0]:
  data=os.read(0,65536)
  if not data:break
  os.write(fd,data)
os.close(fd)
`
  );
  const broker = await CodexInputBroker.create(
    join(root, 'control'),
    SID,
    `exec /usr/bin/python3 -u ${quote(childPath)} ${quote(root)}`,
    root
  );
  const configPath = join(broker.directory, 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as BrokerConfig;
  if (helper) {
    const path = join(broker.directory, 'broker.py');
    await fs.writeFile(path, helper(await fs.readFile(path, 'utf8')));
  }
  startup?.(config);
  await fs.writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const process = spawn(
    '/usr/bin/python3',
    [join(broker.directory, 'broker.py'), broker.directory, hash(JSON.stringify(config))],
    {
      env: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root, LANG: 'C.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  let diagnostics = '';
  process.stderr.on('data', (value) => {
    diagnostics += value.toString();
  });
  process.stdout.on('data', () => {});
  const done = new Promise<void>((resolve) => process.on('close', () => resolve()));
  running.push({ process, root, done });
  await eventually(async () => {
    const state = await broker.readState();
    return state !== undefined && state.startup.status !== 'reserved';
  });
  const state = await broker.readState();
  if (state?.startup.status === 'started')
    await eventually(async () =>
      fs.access(join(root, 'started')).then(
        () => true,
        () => false
      )
    );
  return {
    broker,
    process,
    config,
    root,
    bytes: () => fs.readFile(join(root, 'bytes')),
    diagnostics: () => diagnostics,
  };
}

function startupLease(config: BrokerConfig): void {
  const now = Date.now();
  config.startup.monotonicDeadline = Number(process.hrtime.bigint() / 1_000_000n) + 1500;
  config.startup.issuerLease = {
    phaseIndex: 0,
    remoteDeadline: now + 1500,
    clock: { localAt: now, min: 0, max: 0 },
    claim: {
      version: 1,
      managerSessionId: MANAGER,
      managerIncarnation: randomUUID(),
      sessionId: SID,
      incarnation: config.incarnation,
      conversationId: CID,
      action: 'restart',
      nonce: randomUUID(),
      issuedAt: now,
      deadline: now + 1500,
      fullPayloadHash: config.launchDigest,
      allowedPhaseHashes: [config.launchDigest],
      native: { kind: 'startup', muxSessionId: '$17', paneId: '%19', panePid: 9009, serverPid: 17000 },
    },
  };
}

it('starts only the exact new private incarnation under a scoped remote startup lease', async () => {
  const f = await fixture(startupLease);
  expect((await f.broker.readState())?.startup.status).toBe('started');
  expect((await f.broker.prove(f.process.pid!))?.closed).toBe(false);
});

it.each([
  'wrong-incarnation',
  'wrong-command',
  'wrong-manager',
  'old-clock',
  'local-issuer',
  'null-lease',
  'giant-pane',
  'giant-session',
] as const)('a remote startup %s does not fork the disposable child', async (change) => {
  const f = await fixture((config) => {
    startupLease(config);
    const value = config.startup.issuerLease!;
    if (change === 'wrong-incarnation') value.claim.incarnation = randomUUID();
    if (change === 'wrong-command') value.claim.fullPayloadHash = hash('other command');
    if (change === 'wrong-manager') value.claim.managerSessionId = SID;
    if (change === 'old-clock') value.clock.localAt -= 2001;
    if (change === 'local-issuer') config.startup.issuer = { directory: '/never-open-a-local-manager-path' } as never;
    if (change === 'null-lease') config.startup.issuerLease = null as never;
    if (change === 'giant-pane') value.claim.native.paneId = '%9007199254740992';
    if (change === 'giant-session' && value.claim.native.kind === 'startup')
      value.claim.native.muxSessionId = '$9007199254740992';
  });
  expect((await f.broker.readState())?.startup).toMatchObject({ status: 'not-sent' });
  expect((await f.broker.readState())?.childPid).toBe(0);
  expect(
    await fs.access(join(f.root, 'started')).then(
      () => true,
      () => false
    )
  ).toBe(false);
});

it('keeps a partial phase unknown when its original lease expires between child writes', async () => {
  const f = await fixture(undefined, (source) => {
    const needle = 'count = os.write(master, data[offset:offset + 32768])';
    if (!source.includes(needle)) throw new Error('Fake partial-write seam changed');
    const boundary = source.indexOf('    def forward(');
    if (boundary < 0) throw new Error('Fake child writer seam changed');
    return (
      source.slice(0, boundary) +
      source
        .slice(boundary)
        .replace(needle, 'count = os.write(master, data[offset:offset + 1])')
        .replace(
          'while offset < len(data):\n',
          String.raw`while offset < len(data):
            if offset:
                if end is None: raise AssertionError('Fixture requires an automatic phase deadline')
                marker_path = os.path.join(os.environ['CODEX_HOME'],'partial-written')
                with open(marker_path+'.pending','w') as marker:
                    json.dump({'offset':offset,'end':end,'at':time.monotonic()},marker)
                os.replace(marker_path+'.pending',marker_path)
                while time.monotonic() <= end: time.sleep(.005)
`
        )
    );
  });
  const value = await lease(f, ['partial text']);
  const packet = frame(f, 'partial text', value, 0);
  f.process.stdin.write(packet.data);
  await eventually(async () =>
    fs.access(join(f.root, 'partial-written')).then(
      () => true,
      () => false
    )
  );
  const held = JSON.parse(await fs.readFile(join(f.root, 'partial-written'), 'utf8'));
  expect(held.offset).toBe(1);
  expect(held.at).toBeLessThan(held.end);
  expect(held.end).toBe(value.expiry / 1000);
  await eventually(async () => (await f.bytes()).toString() === 'p');
  expect(await f.broker.receipt(packet.receipt)).toBe('unknown');
  expect((await f.broker.readState())?.receipts.at(-1)?.status).toBe('reserved');
  expect(await f.broker.prove(f.process.pid!)).toBeUndefined();
  expect((await f.bytes()).toString()).toBe('p');
});
afterEach(async () => {
  for (const item of running.splice(0)) {
    await fs.writeFile(join(item.root, 'stop'), 'stop');
    await Promise.race([
      item.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Fake child cleanup expired')), 3000)),
    ]);
    await fs.rm(item.root, { recursive: true, force: true });
  }
});

async function lease(
  f: Awaited<ReturnType<typeof fixture>>,
  chunks: string[],
  offset = 0
): Promise<{ lease: BrokerRemoteIssuerLease; expiry: number }> {
  let observed: Awaited<ReturnType<typeof f.broker.prove>>;
  await eventually(async () => {
    observed = await f.broker.prove(f.process.pid!);
    return observed !== undefined;
  });
  const proof = observed!;
  const remoteNow = Date.now(),
    sourceNow = remoteNow - offset;
  return {
    expiry: Number(process.hrtime.bigint() / 1_000_000n) + 1500,
    lease: {
      phaseIndex: 0,
      remoteDeadline: remoteNow + 1500,
      clock: { localAt: sourceNow, min: offset, max: offset },
      claim: {
        version: 1,
        sessionId: SID,
        incarnation: f.config.incarnation,
        conversationId: CID,
        action: 'input',
        managerSessionId: MANAGER,
        managerIncarnation: randomUUID(),
        nonce: randomUUID(),
        issuedAt: sourceNow,
        deadline: sourceNow + 1500,
        fullPayloadHash: hash(chunks.join('')),
        allowedPhaseHashes: [...chunks, '\r'].map(hash),
        native: {
          kind: 'input',
          paneId: '%19',
          brokerPid: proof.brokerPid,
          childPid: proof.childPid,
          brokerStart: proof.brokerStart!,
          childStart: proof.childStart!,
        },
      },
    },
  };
}
function frame(
  f: Awaited<ReturnType<typeof fixture>>,
  data: string,
  value: Awaited<ReturnType<typeof lease>>,
  index: number
) {
  return f.broker.frame('auto', data, CID, undefined, [], OWNERS, [], [], value.expiry, {
    ...value.lease,
    phaseIndex: index,
  })!;
}

it.each([0, 3_600_000, -3_600_000])(
  'delivers ordered own chunks and actual Enter across a %sms clock offset',
  async (offset) => {
    const f = await fixture();
    const chunks = ['Unicode 😀\nfirst', ' + second'];
    const value = await lease(f, chunks, offset);
    for (let phase = 0; phase <= chunks.length; phase++) {
      const packet = frame(f, chunks[phase] ?? '\r', value, phase);
      f.process.stdin.write(packet.data);
      expect(await f.broker.receipt(packet.receipt)).toBe('sent');
      f.process.stdin.write(packet.data); // The exact authenticated duplicate adds no bytes.
    }
    await eventually(async () => (await f.bytes()).length === Buffer.byteLength(chunks.join('') + '\r'));
    expect((await f.bytes()).toString()).toBe(chunks.join('') + '\r');
    const receipt = (await f.broker.readState())!.receipts.at(-1)!;
    expect(receipt.deliveredAt!.wallBefore).toBeLessThanOrEqual(receipt.deliveredAt!.wallAfter);
    expect(receipt.deliveredAt!.monoBefore).toBeLessThanOrEqual(receipt.deliveredAt!.monoAfter);
    expect(receipt.deliveredAt!.wallAfter).toBeLessThanOrEqual(Date.now());
  }
);

it('preserves the full 64KiB Unicode payload through eight chunks and Enter', async () => {
  const f = await fixture();
  const chunks = Array(8).fill('😀'.repeat(2048)) as string[];
  const value = await lease(f, chunks);
  for (let phase = 0; phase <= chunks.length; phase++) {
    const packet = frame(f, chunks[phase] ?? '\r', value, phase);
    f.process.stdin.write(packet.data);
    expect(await f.broker.receipt(packet.receipt)).toBe('sent');
  }
  await eventually(async () => (await f.bytes()).length === 65537);
  expect(await f.bytes()).toEqual(Buffer.from(chunks.join('') + '\r'));
});

it.each([
  'manager-self',
  'incarnation',
  'conversation',
  'broker-pid',
  'child-pid',
  'birth',
  'phase-hash',
  'phase-order',
  'expired',
  'clock-map',
  'clock-uncertain',
  'path-leak',
  'native-extra',
  'giant-pane',
] as const)('refuses remote phase scope %s before any child byte', async (change) => {
  const f = await fixture();
  const value = await lease(f, ['must not arrive']);
  const claim = value.lease.claim;
  if (change === 'manager-self') claim.managerSessionId = SID;
  if (change === 'incarnation') claim.incarnation = randomUUID();
  if (change === 'giant-pane') claim.native.paneId = '%9007199254740992';
  if (change === 'conversation') claim.conversationId = randomUUID();
  if (claim.native.kind === 'input') {
    if (change === 'broker-pid') claim.native.brokerPid++;
    if (change === 'child-pid') claim.native.childPid++;
    if (change === 'birth') claim.native.childStart = '0';
    if (change === 'native-extra') Object.assign(claim.native, { directory: '/never-open-a-manager-path' });
  }
  if (change === 'phase-hash') (claim.allowedPhaseHashes as string[])[0] = hash('other');
  if (change === 'expired') value.expiry = 1;
  if (change === 'clock-map') value.lease.remoteDeadline++;
  if (change === 'clock-uncertain') value.lease.clock.max = 1001;
  if (change === 'path-leak') Object.assign(claim, { directory: '/never-open-a-manager-path' });
  const packet = frame(f, 'must not arrive', value, change === 'phase-order' ? 1 : 0);
  f.process.stdin.write(packet.data);
  expect(await f.broker.receipt(packet.receipt)).toBe('not-sent');
  expect(await f.bytes()).toHaveLength(0);
});

it.each(['full-hash', 'changed-claim', 'expired', 'owner-input', 'wrong-enter'] as const)(
  'seals already pasted text and refuses Enter after %s',
  async (change) => {
    const f = await fixture();
    const value = await lease(f, ['own literal']);
    if (change === 'full-hash') value.lease.claim.fullPayloadHash = hash('different whole prompt');
    const literal = frame(f, 'own literal', value, 0);
    f.process.stdin.write(literal.data);
    expect(await f.broker.receipt(literal.receipt)).toBe('sent');
    if (change === 'changed-claim') value.lease.claim.managerIncarnation = randomUUID();
    if (change === 'expired') value.expiry = 1;
    if (change === 'owner-input') {
      const owner = f.broker.frame('owner-pty', 'owner draft')!;
      f.process.stdin.write(owner.data);
      expect(await f.broker.receipt(owner.receipt)).toBe('sent');
    }
    const data = change === 'wrong-enter' ? 'x' : '\r';
    if (change === 'wrong-enter') (value.lease.claim.allowedPhaseHashes as string[])[1] = hash(data);
    const enter = frame(f, data, value, 1);
    f.process.stdin.write(enter.data);
    expect(await f.broker.receipt(enter.receipt)).toBe('not-sent');
    expect((await f.bytes()).toString()).toBe('own literal' + (change === 'owner-input' ? 'owner draft' : ''));
    expect((await f.bytes()).includes(13)).toBe(false);
  }
);
