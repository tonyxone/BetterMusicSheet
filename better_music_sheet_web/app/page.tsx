"use client";

import { useAuth } from "./auth-context";
import { LibraryView } from "./library-view";
import { UploadForm } from "./upload-form";

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

  // Nothing until the session check settles - rendering the upload form first
  // and swapping it for the Library a moment later is the flash the header
  // already takes care to avoid.
  if (loading) return null;
  return user ? <LibraryView /> : <UploadForm />;
}
