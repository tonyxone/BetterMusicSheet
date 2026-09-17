"use client";

import { LibraryView } from "../library-view";

// The Library's own URL, for everyone. A signed-in visitor also gets it at
// the root (see app/page.tsx), but a guest does not - the root is the upload
// pitch for them - so this is the only way they reach their sheets, and it is
// where the header's Library icon points.
export default function HistoryPage() {
  return <LibraryView showBack />;
}
