import { zipSync } from 'fflate';

// When the app runs inside a claude.ai artifact, files must go through the viewer's `downloads`
// capability, which only accepts some extensions (zip and json among them). Everywhere else a
// normal browser download is used.

interface DownloadsNS {
  save(req: { filename: string; data: Blob | ArrayBuffer | ArrayBufferView | string }): Promise<{ status: string }>;
}
interface ClaudeHost {
  use(name: 'downloads'): Promise<DownloadsNS | null>;
}

const host = (globalThis as { claude?: ClaudeHost }).claude;
let downloadsPromise: Promise<DownloadsNS | null> | null = null;

function downloads(): Promise<DownloadsNS | null> {
  if (!host?.use) return Promise.resolve(null);
  if (!downloadsPromise) downloadsPromise = host.use('downloads').catch(() => null);
  return downloadsPromise;
}

/** Resolves true when saves go through the claude.ai prompt (which needs model files zipped). */
export function savesAreZipped(): Promise<boolean> {
  return downloads().then((ns) => !!ns);
}

/** Start resolving the capability early so the first click is instant. */
export function warmUpSaving() {
  void downloads();
}

const HOST_OK = /\.(zip|json|txt|svg|png|csv|html|md)$/i;

export type SaveOutcome = 'saved' | 'declined' | 'unavailable';

export async function saveFile(filename: string, data: Uint8Array | string, mime: string): Promise<{ outcome: SaveOutcome; filename: string }> {
  const ns = await downloads();
  if (ns) {
    let name = filename;
    let payload: Uint8Array | string = data;
    if (!HOST_OK.test(filename)) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      payload = zipSync({ [filename]: bytes });
      name = filename.replace(/\.[a-z0-9]+$/i, '') + '.zip';
    }
    try {
      await ns.save({ filename: name, data: new Blob([payload as BlobPart]) });
      return { outcome: 'saved', filename: name };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      return { outcome: code === 'declined' ? 'declined' : 'unavailable', filename: name };
    }
  }
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { outcome: 'saved', filename };
}
