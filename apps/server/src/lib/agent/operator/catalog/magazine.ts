import type { CatalogSurface } from './types.js'

// ---------------------------------------------------------------------------
// Operator catalog — 'magazine' pack (Magazine Builder v2). See ./types.ts for
// the contract.
//
// Web twins (names + zod schemas MUST match):
//   magazine-home   → apps/web/src/editor-v2/operator/useMagazineHomeActions.ts
//   magazine-editor → apps/web/src/editor-v2/operator/useMagazineEditorActions.ts
//
// Page numbers are the REAL page numbers (index + 1) everywhere — as the canvas header
// prints them ("Page 3"); the rail shows the same number. See web operator/shared.ts pageNo().
// An action the user's role can't do is simply not registered on screen, so
// readScreen().actions is the live truth; the server still enforces RBAC.
// ---------------------------------------------------------------------------

export const SURFACES: CatalogSurface[] = [
  {
    id: 'magazine-home',
    title: 'Magazine Builder — library',
    route: '/production-system/magazine-v2',
    who: 'staff with Magazine view; the AI composer needs Magazine create',
    purpose:
      'The library of AI-built magazines plus the composer that starts a new one from a brief. Generate creates the magazine and drops straight into its studio, where the pages keep building for a few minutes.',
    actions: [
      {
        name: 'magazine.list',
        description: 'List the magazines in the library: id, title, status, page count, your role, whether published, editor route.',
        args: '{}',
      },
      {
        name: 'magazine.open',
        description: 'Open a magazine in the studio by id or by (partial) title. Ambiguous titles return the candidates.',
        args: '{ magazine: string }',
      },
      {
        name: 'magazine.generate',
        description:
          'Start a NEW magazine with AI: types the brief, presses Generate, waits for the new studio. Returns AT ONCE { magazineId, route, jobId, started:true }; the pages build in the background and a [job-update] arrives when they finish (do not wait or poll). Use it for "create a (dummy) magazine about …"; there is no blank-magazine button here. A brief that names a larger page count than pageCount is refused: leave page counts out of the brief and pass pageCount.',
        args: '{ brief: string; pageCount?: number /* 3–16, written into the brief */ }',
        confirms: true,
      },
      {
        name: 'magazine.reuseTemplate',
        description: "Start a new magazine from an existing magazine's layout (its text and photos are cleared; the original is untouched), then open it.",
        args: '{ magazineId: string }',
      },
    ],
    anchors: [
      'mag.brief-input',
      'mag.generate-submit',
      'mag.attach-data',
      'mag.attach-images',
      'mag.card-<magazineId>',
      'mag.card-<magazineId>-edit',
      'mag.card-<magazineId>-reuse',
      'mag.card-<magazineId>-delete',
    ],
  },
  {
    id: 'magazine-editor',
    title: 'Magazine Builder — studio',
    route: '/production-system/magazine-v2/:id',
    who: "the magazine's owner (everything), collaborators it was shared with (their pages + the AI Studio), other staff view-only; every change needs Magazine edit, publishing also Magazine publish",
    purpose:
      'Edit one magazine: page rail (add/duplicate/delete/reorder), the canvas (every page stacked; above each a "publish" tick and the Fill and Adjust wands), the AI Studio chat (left; stages edits to the open page), the inspector (right; owner: add text/photo/shape/QR/icon, style, Assets), Share, the review board, Publish to Bulletins. Call magazine.status first. PAGE NUMBERS are the real numbers printed on the canvas ("Page 3"), for a contributor shared only page 3 too. In Studio prompts say "this page", never a magazine page number (a PDF page is fine). Fill / adjust a page = magazine.fillPage / adjustPage, not the studio.',
    actions: [
      {
        name: 'magazine.status',
        description:
          'Title, id, your role and rights, every page (real page number as printed on the canvas, id, elements, review state, selectedForPublish), collaborators with their pages, publish state, build progress, and AI Studio state: replying, studio.pendingChanges per page [{ page, count, changes }], pendingTotal and lastTurn (proposalCount, stagedLine).',
        args: '{}',
      },
      {
        name: 'magazine.waitForGeneration',
        description:
          'Optional (builds report back by themselves with a [job-update]): a quick look at a build in progress, following it for at most 60 s, then { building, done, total, jobId } or the final status. Never call it in a loop.',
        args: '{}',
      },
      {
        name: 'magazine.goToPage',
        description: 'Open a page on the canvas by clicking its thumbnail in the page rail.',
        args: '{ page: number }',
      },
      {
        name: 'magazine.addPage',
        description: 'Owner only. Add a blank page at the end and open it.',
        args: '{}',
      },
      {
        name: 'magazine.addAiPages',
        description:
          'Owner only. The AI designs and appends on-theme pages, optionally on a topic, or written from a document on the magazine (doc = part of its file name; never paste its text into topic). A build makes 1, 2, 3, 4 or 6 pages, so a bigger count starts the largest batch that fits and returns remaining: after the [job-update], call again with count = remaining (no second question). Returns AT ONCE { jobId, started:true }.',
        args: '{ count: number /* 1–12 */; topic?: string /* ≤300 chars */; doc?: string }',
        confirms: true,
      },
      {
        name: 'magazine.duplicatePage',
        description: 'Owner only. Duplicate a page.',
        args: '{ page: number }',
      },
      {
        name: 'magazine.deletePage',
        description: 'Owner only. Delete a page permanently (page deletions cannot be undone).',
        args: '{ page: number }',
        confirms: true,
      },
      {
        name: 'magazine.movePage',
        description: 'Owner only. Move a page to another position.',
        args: '{ from: number; to: number }',
      },
      {
        name: 'magazine.rename',
        description: "Owner only. Rename the magazine via the toolbar's title field.",
        args: '{ title: string }',
      },
      {
        name: 'magazine.listStaff',
        description: 'Owner only. Staff who could be invited (userId, name, email, access: owner|collaborator|none), optionally filtered by text. Use it to resolve a name before sharing.',
        args: '{ query?: string }',
      },
      {
        name: 'magazine.sharePages',
        description:
          "Owner only. Share pages through the Share dialog: person is a userId, email or name (ambiguous names return the candidates). A new collaborator is emailed a link; for an existing one this changes which pages they may edit. Someone NOT on the team yet: pass their EMAIL (ask the user for it if you only have a name) AND the role they join the team with — always ASK the user which role, never choose one (called without role it returns the choices) — they're emailed an invite, the share is saved as pending, and they get the pages AUTOMATICALLY when they accept; never tell the user to share again once they've signed up. Returns the updated collaborator list (pendingInvites for people not joined yet).",
        args: "{ person: string; pages: number[] | 'all'; role?: string }",
        confirms: true,
      },
      {
        name: 'magazine.unshare',
        description: "Owner only. Remove a collaborator's access (person = userId, email or name), or cancel a pending share with someone invited by email who hasn't joined.",
        args: '{ person: string }',
        confirms: true,
      },
      {
        name: 'magazine.askStudio',
        description:
          'Owner or collaborator. Send a request to the AI Studio chat (optionally opening a page first) and wait for the whole turn (up to 10 min). It only STAGES changes: pass apply:true when the user wants them made (presses "Use these changes"; page deletions, a layout rebuild or an AI page build ask the user first). Attach a user image first with upload on mag.ai-attach; a document already on the magazine needs no re-upload, just name its file. Trust proposalCount and stagedLine (what this turn REALLY staged; 0 = nothing changed) over the reply; pendingChanges covers every page. The studio can do anything the Page & Element panel can (charts, background, clear a page, picture fit and shape, fonts, alignment, rotate, front/back, duplicate, QR and icon colours, arrange boxes) except the page\'s publish tick (magazine.setPageInPublish).',
        args: '{ prompt: string /* ≤4000 chars */; page?: number; apply?: boolean }',
      },
      {
        name: 'magazine.waitForStudio',
        description:
          'The studio is still working (reading an attachment or replying) or has changes waiting: wait for it (up to 10 min), then with apply:true press "Use these changes". Use it instead of telling the user "the studio is still working".',
        args: '{ apply?: boolean }',
      },
      {
        name: 'magazine.applyStudioChanges',
        description:
          'Apply EVERY page\'s waiting AI Studio changes in page order (the "Apply all" bar), or only that page\'s with page. Ctrl+Z undoes it, except page deletions, a layout rebuild and a PDF page copy (those and an AI page build ask the user first); changes waiting on pages other than the latest request\'s get a card listing every page and its count. A text edit whose box was edited after staging is held back and stays waiting (perPage heldBecauseEditedSinceStaged): apply it again only if the user says so. Returns perPage, line, stillWaiting and the pages measured afterwards (pageCheck, pageChecks).',
        args: '{ page?: number }',
        confirms: true,
      },
      {
        name: 'magazine.discardStudioChanges',
        description: 'Discard EVERY page\'s waiting AI Studio changes (the bar\'s Discard), or only that page\'s with page; nothing on the pages changes, and the user is offered Bring back for a few seconds.',
        args: '{ page?: number }',
      },
      {
        name: 'magazine.publish',
        description:
          'Owner with Magazine publish. Publish or republish to the public Bulletins newsstand: omit pages for the full edition, or give page numbers to publish only those ("publish pages 1–4" → pages:[1,2,3,4]). Refused with the reason if pages still need approval or a build is running. Returns publishedIssueId + public route.',
        args: '{ pages?: number[] }',
        confirms: true,
      },
      {
        name: 'magazine.unpublish',
        description: 'Owner with Magazine publish. Take the live edition off Bulletins (the draft stays).',
        args: '{}',
        confirms: true,
      },
      {
        name: 'magazine.fillPage',
        description:
          'Owner or collaborator. Press the Fill wand above that page: writes copy into EMPTY text boxes and tightens crowded text, then waits for the pass. Use it directly for "fill page N" / "fill the empty boxes". Returns the before/after of each changed block and the toast text. Undoable (magazine.undo).',
        args: '{ page: number }',
      },
      {
        name: 'magazine.adjustPage',
        description:
          'Owner or collaborator. Press the Adjust wand above that page: tightens crowded or overflowing text and re-balances an AI-built layout (box sizes, empty bands, sliver photos); writes no new copy. Use it for "adjust page N" / "fix the overflowing text". Returns what changed + the toast text. Undoable (magazine.undo).',
        args: '{ page: number }',
      },
      // Seeing the page, charts and magazine-wide find-and-replace (C15/C37/C48).
      // Kept to 200 characters each: the fuller wording lives in the web
      // useAgentAction descriptions, which readScreen lists live. ChartSpec in
      // addChart mirrors the server's chartSpecSchema (lib/magazineV2/chartSpec.ts).
      {
        name: 'magazine.checkPage',
        description:
          'Measure a page as drawn in the browser (default: the open page): pageCheck { ok, issues with measured px and a fix } plus its elements. Use after a change the user asked for.',
        args: '{ page?: number }',
      },
      {
        name: 'magazine.checkAllPages',
        description:
          'Measure EVERY page once (changes nothing): errors per page in words, pagesWithErrors, fixEstimate (time and AI cost). Report and ASK before fixing.',
        args: '{}',
      },
      {
        name: 'magazine.fixPages',
        description:
          'After the user agrees: fix the errors on these pages in ONE pass, each page once, all its problems in one request (asks to confirm, with time and cost).',
        args: '{ pages?: number[] }',
      },
      {
        name: 'magazine.lookAtPage',
        description:
          'Visual review of the SAVED page: a vision model lists the problems in a render (with element ids), plus pageCheck. Use after a new picture, chart or layout, or if it LOOKS wrong; focus narrows it.',
        args: '{ page?: number; focus?: string }',
      },
      {
        name: 'magazine.addChart',
        description:
          'Draw a chart from the EXACT numbers (one value per category, in order) onto the page, or in place of element id replace; barh for long names, pie/donut one series. Returns dataEcho + pageCheck.',
        args: "{ page?: number; chart: { type: 'bar'|'barh'|'line'|'pie'|'donut'|'table'; title?, subtitle?, source?: string; categories: string[]; series: { name: string; values: number[] }[]; unit?: { prefix?, suffix?: string }; decimals?: 0|1|2; showValues?, stacked?: boolean; highlight?: string /* a category */ }; replace?: string }",
      },
      {
        name: 'magazine.editChart',
        description:
          'Change a chart addChart drew (elementId from checkPage): changes.setValues for single numbers ("2023 is 14"), or any chart field to replace it; an empty title removes it. Returns dataEcho + pageCheck.',
        args: '{ page?: number; elementId: string; changes: { setValues?: { category: string; series?: string; value: number }[] /* or any chart field */ } }',
      },
      {
        name: 'magazine.replaceText',
        description:
          'Swap a word or name in the text of EVERY page you may edit, exactly (nothing is retyped); the user OKs a count per page first. matchCase defaults to true. Ctrl+Z cannot undo it: swap back to reverse.',
        args: '{ find: string; replace: string; matchCase?: boolean; wholeWord?: boolean }',
        confirms: true,
      },
      {
        name: 'magazine.setPageInPublish',
        description:
          'Owner only. Tick (include:true) or untick the "publish" box in the page\'s canvas header — whether the page goes out with "Publish selected pages". A full-edition publish ignores it. Returns the selected page list.',
        args: '{ page: number; include: boolean }',
      },
      {
        name: 'magazine.undo',
        description: 'Press Undo in the toolbar: takes back the last edit (a whole AI apply or Fill/Adjust pass is one step). Page deletions cannot be undone. Returns what was undone and what is next.',
        args: '{}',
      },
      {
        name: 'magazine.redo',
        description: 'Press Redo in the toolbar: re-applies the last undone edit.',
        args: '{}',
      },
      {
        name: 'magazine.zoom',
        description: "Zoom the canvas with the toolbar − / + buttons: action 'in' or 'out' for one step, or percent (≈22–110) to step to the nearest level. Returns zoomPercent.",
        args: "{ percent?: number; action?: 'in' | 'out' }",
      },
      {
        name: 'magazine.setCover',
        description:
          "Owner only. Set the newsstand cover via More ▸ Cover image…: page (use that page's picture), imageUrl (an image URL), or reset:true (automatic from page 1). Give exactly one. The cover is stored on the draft; the live newsstand card changes at the next publish.",
        args: '{ page?: number; imageUrl?: string; reset?: boolean }',
      },
      {
        name: 'magazine.openReviewBoard',
        description:
          'Open the review board and return the pages in each column (in_progress, needs_changes, submitted, approved), stale approvals, and which pages you can tick. The board only exists when the magazine is shared with someone.',
        args: '{}',
      },
      {
        name: 'magazine.reviewPages',
        description:
          "On the review board: the owner uses action 'approve' or 'sendBack' (note required) on submitted / stale pages; a collaborator uses 'submit' for their finished pages. Ticks exactly those pages, writes the note, presses the button; the people involved are emailed. Returns moved / notMoved pages.",
        args: "{ action: 'approve' | 'sendBack' | 'submit'; pages: number[]; note?: string }",
        confirms: true,
      },
      {
        name: 'magazine.addMorePages',
        description:
          'Owner only. Press "Add more pages" (the gold banner after a first build, else the rail\'s AI button); with count (batched like addAiPages), and topic or doc as there, it also starts the build and returns AT ONCE { jobId, started:true }.',
        args: '{ count?: number /* 1–12 */; topic?: string /* ≤300 chars */; doc?: string }',
        confirms: true,
      },
      // Danger actions — web twin: apps/web/src/editor-v2/operator/useMagazineDangerActions.ts.
      // Each drives the real button; the app's own window.confirm() is answered by
      // the user's OK on the Operator's confirm card (runtime/nativeDialogs.ts).
      {
        name: 'magazine.deleteMagazine',
        description:
          'Owner with Magazine delete. Delete this whole magazine (draft + every page) via More ▸ Delete magazine…; a live one also comes off Bulletins. Cannot be undone. Ends in the library.',
        args: '{}',
        confirms: true,
      },
      {
        name: 'magazine.startOver',
        description:
          'Owner only. More ▸ Start over…: reset this magazine to ONE blank page — every page and its content is deleted and undo history cleared. Cannot be undone.',
        args: '{}',
        confirms: true,
      },
      // copyPdfPage takes the PDF the user sent in THIS chat as "attachment" and
      // stores it on the magazine itself. The old hint (upload on mag.ai-attach)
      // only staged the file in the studio composer, which the Copy panel never
      // reads, so the copy failed and its own error sent the model round the same
      // loop, or silently copied another PDF already on the magazine (C18/C26).
      {
        name: 'magazine.copyPdfPage',
        description:
          'Owner only. "Copy a page exactly": reproduce page docPage of a PDF (its words, pictures and colours; a scan comes over as one picture) onto page (default: the open page), replacing everything there, in the PDF page\'s shape. Cannot be undone. A PDF sent in THIS chat: attachment (0 = the newest, or its file name), stored on the magazine first; doc = part of the file name of one already on it. Layout only (fresh copy): applyLayout.',
        args: '{ page?: number; docPage: number; doc?: string; attachment?: number | string }',
        confirms: true,
      },
      {
        name: 'magazine.applyLayout',
        description:
          'Owner only. "Match a layout": rebuild page (default: the open page) in the ARRANGEMENT of a reference picture the user sent, with fresh copy (nothing copied). fit "exact" = boxes where the reference had them; "adapt" = re-composed around this page\'s content. Replaces everything; cannot be undone. Flow: call once (opens page + panel), upload { agentId: "mag.layout-upload", attachment } with the image, call again (asks the user, rebuilds, returns the measured verdict).',
        args: "{ page?: number; fit: 'exact' | 'adapt' }",
        confirms: true,
      },
    ],
    anchors: [
      'mag.back',
      'mag.title-input',
      'mag.undo',
      'mag.redo',
      'mag.review-board',
      'mag.publish-button',
      'mag.publish-full',
      'mag.publish-selected',
      'mag.unpublish',
      'mag.view-live',
      'mag.more-button',
      'mag.share-button',
      'mag.cover-button',
      'mag.ai-toggle',
      'mag.add-more-pages',
      'mag.pages-show',
      'mag.pages-rail',
      'mag.page-<n>',
      'mag.page-<n>-up',
      'mag.page-<n>-down',
      'mag.page-<n>-duplicate',
      'mag.add-page',
      'mag.add-ai-pages',
      'mag.ai-pages-count',
      'mag.ai-pages-topic',
      'mag.ai-pages-generate',
      'mag.ai-tab-chat',
      'mag.ai-tab-uploads',
      'mag.ai-new-chat',
      'mag.ai-input',
      'mag.ai-send',
      'mag.ai-apply',
      'mag.ai-discard',
      'mag.share-dialog',
      'mag.share-person',
      'mag.share-scope-all',
      'mag.share-scope-pick',
      'mag.share-page-<n>',
      'mag.share-submit',
      'mag.share-collab-<userId>',
      'mag.share-invite-email',
      'mag.share-invite-role',
      'mag.share-pending-<email>',
      'mag.share-pending-remove-<email>',
      'mag.share-close',
      'mag.publish-dialog',
      'mag.publish-page-<n>',
      'mag.publish-confirm',
      // Canvas: the header above EVERY page (n = the real page number, as printed on the canvas)
      'mag.page-<n>-fill',
      'mag.page-<n>-adjust',
      'mag.page-<n>-publish-toggle',
      // Toolbar / More menu / banners
      'mag.zoom-out',
      'mag.zoom-in',
      'mag.zoom-level',
      'mag.start-over',
      'mag.delete-magazine',
      'mag.add-more-pages-dismiss',
      'mag.locked-see-board',
      'mag.page-<n>-delete',
      'mag.pages-hide',
      'mag.ai-pages-cancel',
      // Cover dialog
      'mag.cover-dialog',
      'mag.cover-tab-pages',
      'mag.cover-tab-library',
      'mag.cover-tab-upload',
      'mag.cover-page-<n>',
      'mag.cover-asset-<assetId>',
      'mag.cover-upload',
      'mag.cover-url',
      'mag.cover-url-set',
      'mag.cover-reset',
      'mag.cover-close',
      // Review board
      'mag.review-dialog',
      'mag.review-page-<n>-select',
      'mag.review-page-<n>-open',
      'mag.review-note',
      'mag.review-approve',
      'mag.review-send-back',
      'mag.review-submit',
      'mag.review-close',
      // Inspector (owner; right pane)
      'mag.inspector-show',
      'mag.inspector-hide',
      'mag.insert-text',
      'mag.insert-image',
      'mag.insert-shape',
      'mag.insert-qr',
      'mag.insert-icon',
      'mag.inspector-tab-element',
      'mag.inspector-tab-assets',
      'mag.inspector-publish-toggle',
      'mag.el-content',
      'mag.el-image-upload',
      'mag.el-image-url',
      'mag.el-qr-url',
      'mag.el-to-front',
      'mag.el-to-back',
      'mag.el-duplicate',
      'mag.el-delete',
      'mag.assets-mode-library',
      'mag.assets-mode-find',
      'mag.assets-mode-make',
      'mag.asset-<assetId>',
      'mag.stock-query',
      'mag.stock-search',
      'mag.stock-result-<photoId>',
      'mag.imagegen-prompt',
      'mag.imagegen-style',
      'mag.imagegen-decorative',
      'mag.imagegen-submit',
      'mag.imagegen-chart-refused',
      'mag.layout-pdf-doc',
      'mag.layout-pdf-page',
      'mag.layout-pdf-go',
      'mag.layout-upload',
      'mag.layout-fit-exact',
      'mag.layout-fit-adapt',
      'mag.layout-apply',
      'mag.copy-pdf-doc',
      'mag.copy-pdf-page',
      'mag.copy-pdf-go',
      'mag.copy-pdf-status',
      'mag.preview-close',
      // AI Studio extras
      'mag.ai-threads',
      'mag.ai-threads-new',
      'mag.ai-threads-close',
      'mag.ai-thread-<threadId>',
      'mag.ai-attach',
      'mag.ai-mic',
      'mag.ai-voice',
      'mag.ai-load-older',
      'mag.ai-uploads-add',
      'mag.ai-upload-<uploadId>',
      'mag.ai-upload-<uploadId>-fill',
    ],
  },
]
