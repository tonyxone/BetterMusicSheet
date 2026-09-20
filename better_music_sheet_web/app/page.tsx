"use client";

import { useAuth } from "./auth-context";
import { LibraryView } from "./library-view";
import { Landing } from "./landing";

// The root page shows whichever is the visitor's starting point.
//
// Signed in, you already have sheets and want to get back to them, so the
// Library greets you. Signed out, the Library would be an empty box with
// nothing explaining what the site is for, so the upload pitch stays the
// landing page - the same form that lives at /upload, rendered here rather
// than redirected to, so a first-time visitor lands on content instead of a
// hop. Signing in or out re-renders this, since it reads the same context
// the header does.
//
// A guest can still have a library of their own (uploads work signed out,
// tracked by a guest id); /history is where they find it, and that is why the
// header's Library icon points there rather than here.
export default function Home() {
  const { user, loading } = useAuth();

  // The landing page is what an unsettled session gets, not nothing. This page
  // is a static export: whatever renders here at build time is the HTML served
  // to anyone who asks for the domain, so returning null meant the site's front
  // page had no content in it at all - no headline, no description, nothing a
  // reader or a crawler could tell the site's purpose from.
  //
  // A signed-in visitor therefore sees the landing for the moment the session
  // check takes, where before they saw blank. That is the trade: a brief flash
  // of the right page instead of a fast flash of an empty one.
  return user && !loading ? <LibraryView /> : <Landing />;
}
