/**
 * @fileoverview Unit tests for the Ctrl+V paste trap in image-input.js.
 *
 * `_handleImagePaste()` appends a hidden contenteditable div (the "paste
 * trap"), focuses it, and reads the clipboard out of the paste event the
 * browser delivers there. Two things can deliver that event for a single
 * Ctrl+V: the `document.execCommand('paste')` the function issues itself, and
 * the keydown's own default action, which still runs because xterm's custom key
 * handler returns false without cancelling the event. A browser that honours
 * execCommand('paste') therefore fires the trap's listener twice, and the
 * clipboard text used to reach the PTY twice with it — while right-click →
 * Paste, which involves no keydown, stayed correct.
 *
 * Loads the browser module into a vm sandbox with a fake document, so the tests
 * drive the trap's listener directly rather than through a real browser.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const imageInputSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/image-input.js'), 'utf8');

interface TrapListener {
  (e: Record<string, unknown>): void;
}

interface FakeTrap {
  contentEditable: string;
  style: { cssText: string };
  parentNode: unknown;
  focus: () => void;
  addEventListener: (ev: string, fn: TrapListener) => void;
}

interface Harness {
  app: Record<string, any>;
  focusElsewhere: () => void;
  terminalFocus: ReturnType<typeof vi.fn>;
  /** Fire a paste event on the trap the last _handleImagePaste() call created. */
  firePaste: (payload: { text?: string; images?: string[] }) => void;
  /** Text handed to xterm's terminal.paste(), one entry per call. */
  pastedText: string[];
  /** Image batches handed to _uploadAndInsertImages(), one entry per call. */
  uploadedBatches: Array<Array<{ type: string }>>;
  /** How many trap divs are still attached to the fake body. */
  attachedTraps: () => number;
  runTimers: () => void;
}

function loadPasteHarness(options: { mode?: string; refused?: boolean } = {}): Harness {
  const traps: FakeTrap[] = [];
  const listeners: TrapListener[] = [];
  const attached = new Set<FakeTrap>();
  const timers: Array<() => void> = [];

  const documentObj = {
    activeElement: null as unknown,
    createElement: (): FakeTrap => {
      const trap: FakeTrap = {
        contentEditable: '',
        style: { cssText: '' },
        parentNode: null,
        focus: () => {
          documentObj.activeElement = trap;
        },
        addEventListener: (ev: string, fn: TrapListener) => {
          if (ev === 'paste') listeners.push(fn);
        },
      };
      traps.push(trap);
      return trap;
    },
    body: {
      appendChild: (el: FakeTrap) => {
        attached.add(el);
        el.parentNode = documentObj.body;
      },
      removeChild: (el: FakeTrap) => {
        attached.delete(el);
        el.parentNode = null;
      },
    },
    // A browser that honours the command fires the trap's paste listener from
    // here as well; the tests model that by firing the listener twice.
    execCommand: () => {
      if (options.refused) throw new Error('Clipboard permission refused');
      return true;
    },
    getElementById: () => null,
  };

  const context = vm.createContext({
    window: {},
    document: documentObj,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
    console,
  });

  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(imageInputSource, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;

  const pastedText: string[] = [];
  const uploadedBatches: Array<Array<{ type: string }>> = [];
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  app.sessions = new Map([['session-1', { mode: options.mode || 'claude' }]]);
  const terminalFocus = vi.fn();
  app.terminal = {
    paste: (text: string) => pastedText.push(text),
    input: (text: string) => pastedText.push(text),
    focus: terminalFocus,
    modes: { bracketedPasteMode: false },
  };
  app._uploadAndInsertImages = (files: Array<{ type: string }>) => {
    uploadedBatches.push(Array.from(files));
  };
  app.showToast = () => {};

  (app._handleImagePaste as () => void).call(app);

  return {
    app,
    terminalFocus,
    focusElsewhere: () => {
      documentObj.activeElement = {};
    },
    firePaste({ text = '', images = [] }) {
      const items = images.map((type) => ({ type, getAsFile: () => ({ type }) }));
      const event = {
        clipboardData: {
          items,
          getData: () => text,
        },
        preventDefault: () => {},
        stopPropagation: () => {},
      };
      for (const fn of listeners) fn(event);
    },
    pastedText,
    uploadedBatches,
    attachedTraps: () => attached.size,
    runTimers: () => {
      const pending = timers.splice(0, timers.length);
      for (const fn of pending) fn();
    },
  };
}

function loadImageInputApp() {
  const context = vm.createContext({ console, window: {}, document: {} });
  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(imageInputSource, context, { filename: 'image-input.js' });
  const CodemanApp = vm.runInContext('CodemanApp', context) as new () => Record<string, unknown>;
  const app = new CodemanApp();
  app.activeSessionId = 'session-1';
  app.showToast = vi.fn();
  app.sendInput = vi.fn(async () => {});
  app._sendInputAsync = vi.fn();
  app._normalizeImageForUpload = vi.fn(async (file) => file);
  app._uploadPasteImage = vi.fn(async (_sessionId, file: { path: string }) => file.path);
  return app as Record<string, any>;
}

describe('Ctrl+V paste trap', () => {
  it('preserves multiline Unicode Codex text inside one paste after terminal replay', () => {
    const h = loadPasteHarness({ mode: 'codex' });
    h.firePaste({ text: '  α\r\n🙂\n終  ' });
    h.firePaste({ text: '  α\r\n🙂\n終  ' });
    expect(h.pastedText).toEqual(['\x1b[200~  α\r🙂\r終  \x1b[201~']);
  });

  it('cleans a clipboard-refused trap and restores the terminal without sending input', () => {
    const h = loadPasteHarness({ refused: true });
    expect(h.attachedTraps()).toBe(1);
    h.runTimers();
    expect(h.attachedTraps()).toBe(0);
    expect(h.terminalFocus).toHaveBeenCalledOnce();
    expect(h.pastedText).toEqual([]);
  });

  it('does not steal focus back from a text field after a paste', () => {
    const h = loadPasteHarness();
    h.firePaste({ text: 'hello' });
    h.focusElsewhere();
    h.runTimers();
    expect(h.terminalFocus).not.toHaveBeenCalled();
    expect(h.attachedTraps()).toBe(0);
  });

  it('refuses text and image paste after the primary target changes', () => {
    const h = loadPasteHarness();
    h.app.activeSessionId = 'session-2';
    h.firePaste({ text: 'old target', images: ['image/png'] });
    expect(h.pastedText).toEqual([]);
    expect(h.uploadedBatches).toEqual([]);
    expect(h.attachedTraps()).toBe(0);
  });

  it('keeps one active trap and one delivery when another paste gesture replaces it', () => {
    const h = loadPasteHarness();
    h.app._handleImagePaste();
    expect(h.attachedTraps()).toBe(1);
    h.firePaste({ text: 'latest paste' });
    expect(h.pastedText).toEqual(['latest paste']);
    h.runTimers();
    expect(h.attachedTraps()).toBe(0);
  });

  it('sends clipboard text to the terminal once for a single paste event', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });

    expect(h.pastedText).toEqual(['hello world']);
  });

  it('ignores a second paste event for the same Ctrl+V', () => {
    const h = loadPasteHarness();

    // execCommand('paste') and the uncancelled keydown's default action both
    // land on the same trap in browsers that honour the command.
    h.firePaste({ text: 'hello world' });
    h.firePaste({ text: 'hello world' });

    expect(h.pastedText).toEqual(['hello world']);
  });

  it('uploads a pasted image once when the trap sees two paste events', () => {
    const h = loadPasteHarness();

    h.firePaste({ images: ['image/png'] });
    h.firePaste({ images: ['image/png'] });

    expect(h.uploadedBatches).toHaveLength(1);
    expect(h.uploadedBatches[0]).toEqual([{ type: 'image/png' }]);
    expect(h.pastedText).toEqual([]);
  });

  it('removes the trap and hands focus back after the paste it accepted', () => {
    const h = loadPasteHarness();

    h.firePaste({ text: 'hello world' });
    expect(h.attachedTraps()).toBe(1);

    h.runTimers();
    expect(h.attachedTraps()).toBe(0);
  });
});

describe('image upload insertion policy', () => {
  it('returns ordered paths without terminal insertion when requested by the composer', async () => {
    const app = loadImageInputApp();
    const files = [{ path: '/tmp/first.png' }, { path: '/tmp/second.png' }];

    const paths = await app._uploadAndInsertImages(files, { insert: false });

    expect(Array.from(paths)).toEqual(['/tmp/first.png', '/tmp/second.png']);
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('preserves terminal insertion by default', async () => {
    const app = loadImageInputApp();

    const paths = await app._uploadAndInsertImages([{ path: '/tmp/legacy.png' }]);

    expect(Array.from(paths)).toEqual(['/tmp/legacy.png']);
    // The same delivery sendInput() uses (durable queue, useMux for the POST
    // fallback), but addressed to the session the batch was uploaded to.
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '/tmp/legacy.png', { useMux: true });
  });

  it('inserts into the session the upload started in, even after a tab switch mid-upload', async () => {
    const app = loadImageInputApp();
    // The user switches tabs while the upload is in flight. sendInput() re-read
    // activeSessionId after the awaits, so the paths used to land in session-2.
    app._uploadPasteImage = vi.fn(async (_sessionId, file: { path: string }) => {
      app.activeSessionId = 'session-2';
      return file.path;
    });

    await app._uploadAndInsertImages([{ path: '/tmp/shot.png' }]);

    expect(app._uploadPasteImage).toHaveBeenCalledWith('session-1', { path: '/tmp/shot.png' });
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-1', '/tmp/shot.png', { useMux: true });
    expect(app.sendInput).not.toHaveBeenCalled();
  });

  it('uploads to and inserts into an explicitly named session', async () => {
    const app = loadImageInputApp();

    await app._uploadAndInsertImages([{ path: '/tmp/pane-b.png' }], { sessionId: 'session-b' });

    expect(app._uploadPasteImage).toHaveBeenCalledWith('session-b', { path: '/tmp/pane-b.png' });
    expect(app._sendInputAsync).toHaveBeenCalledWith('session-b', '/tmp/pane-b.png', { useMux: true });
  });

  it('shows the server reason in the toast when an upload fails', async () => {
    const app = loadImageInputApp();
    const reason = 'Prompt uploads are not supported for remote (SSH) sessions';
    app._uploadPasteImage = vi.fn(async () => {
      throw new Error(reason);
    });

    await app._uploadAndInsertImages([{ path: '/tmp/shot.png' }]);

    expect(app.showToast).toHaveBeenCalledWith(`1 failed: ${reason}`, 'error');
  });
});

describe('per-kind upload batch admission', () => {
  const file = (name: string, type = '') => ({ name, type, path: '/uploads/' + name });
  it('drops the fourth video before normalization or upload and reports the exact skipped count', async () => {
    const app = loadImageInputApp(),
      files = [1, 2, 3, 4].map((n) => file(`clip-${n}.mp4`, 'video/mp4'));
    const paths = await app._uploadAndInsertImages(files);
    expect(Array.from(paths)).toEqual(files.slice(0, 3).map((row) => row.path));
    expect(app._normalizeImageForUpload.mock.calls.map(([row]) => row)).toEqual(files.slice(0, 3));
    expect(app._uploadPasteImage.mock.calls.map(([, row]) => row)).toEqual(files.slice(0, 3));
    expect(app.showToast).toHaveBeenLastCalledWith('3 files ready · max 3 videos per batch (1 skipped)', 'info');
    expect(app._sendInputAsync).toHaveBeenCalledWith(
      'session-1',
      files
        .slice(0, 3)
        .map((row) => row.path)
        .join(' '),
      { useMux: true }
    );
  });
  it('accepts exactly three videos without a cap warning, even with MIME-free extension classification', async () => {
    const app = loadImageInputApp(),
      files = [file('one.mov', 'video/quicktime'), file('two.webm', 'video/webm'), file('three.mp4')];
    expect(Array.from(await app._uploadAndInsertImages(files, { insert: false }))).toEqual(
      files.map((row) => row.path)
    );
    expect(app._uploadPasteImage).toHaveBeenCalledTimes(3);
    expect(app._sendInputAsync).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenLastCalledWith('3 files ready', 'success');
  });
  it('retains mixed image/document selection order and does not spend their slots on excess videos', async () => {
    const app = loadImageInputApp(),
      files = [
        file('one.mp4'),
        file('photo.png', 'image/png'),
        file('two.mov'),
        file('notes.pdf'),
        file('three.webm'),
        file('skipped.mp4'),
        file('after.md'),
      ];
    const expected = [files[0], files[1], files[2], files[3], files[4], files[6]];
    expect(Array.from(await app._uploadAndInsertImages(files, { insert: false }))).toEqual(
      expected.map((row) => row.path)
    );
    expect(app._uploadPasteImage.mock.calls.map(([, row]) => row)).toEqual(expected);
    expect(app.showToast).toHaveBeenLastCalledWith('6 files ready · max 3 videos per batch (1 skipped)', 'info');
  });
  it('retains the overall twenty-file bound as well as the three-video bound for a large mixed batch', async () => {
    const app = loadImageInputApp(),
      videos = [1, 2, 3, 4].map((n) => file(`clip-${n}.mp4`)),
      documents = Array.from({ length: 21 }, (_, n) => file(`doc-${n}.pdf`));
    const expected = [...videos.slice(0, 3), ...documents.slice(0, 17)];
    expect(Array.from(await app._uploadAndInsertImages([...videos, ...documents], { insert: false }))).toEqual(
      expected.map((row) => row.path)
    );
    expect(app._uploadPasteImage).toHaveBeenCalledTimes(20);
    expect(app.showToast).toHaveBeenLastCalledWith(
      '20 files ready · max 20 per batch · max 3 videos per batch (1 skipped)',
      'info'
    );
  });
  it.each(['image/png', 'application/pdf'])(
    'keeps the original twenty-file image/document cap for %s',
    async (type) => {
      const app = loadImageInputApp(),
        files = Array.from({ length: 21 }, (_, n) => file(`file-${n}.${type === 'image/png' ? 'png' : 'pdf'}`, type));
      expect(Array.from(await app._uploadAndInsertImages(files, { insert: false }))).toEqual(
        files.slice(0, 20).map((row) => row.path)
      );
      expect(app.showToast).toHaveBeenLastCalledWith('20 files ready · max 20 per batch', 'info');
    }
  );
  it('keeps selected-session insertion and FIFO ordering when three admitted video uploads finish out of order after a tab switch', async () => {
    const app = loadImageInputApp(),
      files = [1, 2, 3, 4].map((n) => file(`clip-${n}.mp4`));
    const finish: Array<() => void> = [];
    app._uploadPasteImage = vi.fn((_sid, row) => new Promise((resolve) => finish.push(() => resolve(row.path))));
    const uploading = app._uploadAndInsertImages(files, { sessionId: 'session-b' });
    await vi.waitFor(() => expect(finish).toHaveLength(3));
    app.activeSessionId = 'session-2';
    finish[2]();
    finish[0]();
    finish[1]();
    expect(Array.from(await uploading)).toEqual(files.slice(0, 3).map((row) => row.path));
    expect(app._uploadPasteImage.mock.calls.map(([sid]) => sid)).toEqual(['session-b', 'session-b', 'session-b']);
    expect(app._sendInputAsync).toHaveBeenCalledExactlyOnceWith(
      'session-b',
      files
        .slice(0, 3)
        .map((row) => row.path)
        .join(' '),
      { useMux: true }
    );
    expect(app.sendInput).not.toHaveBeenCalled();
  });
  it('translates the exact video-cap feedback with the real localization helper', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    try {
      vm.runInContext(
        readFileSync(resolve(import.meta.dirname, '../src/web/public/i18n.js'), 'utf8'),
        dom.getInternalVMContext()
      );
      const i18n = Reflect.get(dom.window, 'CodemanI18n');
      i18n.configure({ language: 'zh-CN' });
      expect(i18n.t('max {limit} videos per batch ({skipped} skipped)', { limit: 3, skipped: 1 })).toBe(
        '每批最多 3 个视频（已跳过 1 个）'
      );
    } finally {
      dom.window.close();
    }
  });
});
