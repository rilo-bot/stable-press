// ---------------------------------------------------------------------------
// Magazine Builder v2 — the page, MEASURED, for an Operator action's result.
//
// readScreen is text only: it cannot see a box, a size or a picture, and clipped
// words still read as "on the page" — which is how The Stable Hand once reported a
// broken page as done, or told the user it could not see the page at all. After
// an action changes a page, its result carries the page measured in the browser
// (editor-v2/pageCheck: the page mounted off-screen at its real width, fonts and
// images loaded), so the AI reports what is really there and fixes what is not.
//
// Its own module (not ./shared) so the library screen, which shares those helpers,
// does not pull the page renderer into its bundle.
// ---------------------------------------------------------------------------

import { useEditorStore } from '../store';
import { getPage } from '../api';
import { measurePage } from '../pageCheck';

export type MeasuredPage = Awaited<ReturnType<typeof measurePage>>;

/**
 * The page check of `pageId` (the open copy when it is the open page, else a
 * fresh read), or `{ unavailable }` with the reason. Never throws: a measurement
 * that cannot run must not turn an action that worked into an error.
 */
export async function pageCheckFor(pageId: string, timeoutMs = 12_000): Promise<MeasuredPage | { unavailable: string }> {
  try {
    const st = useEditorStore.getState();
    const page = st.page?.id === pageId ? st.page : st.issueId ? await getPage(st.issueId, pageId) : null;
    if (!page) return { unavailable: 'The page is not loaded.' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Measuring the page took too long.')), timeoutMs);
    });
    try {
      return await Promise.race([measurePage(page), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : 'The page could not be measured.' };
  }
}
