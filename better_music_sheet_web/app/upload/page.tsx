import { UploadForm } from "../upload-form";

// Public upload page (see the note in app/page.tsx) - UploadForm itself
// prompts sign-in when a signed-out visitor tries to actually use it.
export default function Upload() {
  return <UploadForm />;
}
