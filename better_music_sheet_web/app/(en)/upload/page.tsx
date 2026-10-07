import { UploadForm } from "../../upload-form";
import { pageMetadata } from "@/lib/i18n/metadata";

export const generateMetadata = () => pageMetadata("/upload/");

// Public upload page (see the note in app/home.tsx) - UploadForm itself
// prompts sign-in when a signed-out visitor tries to actually use it.
export default function Upload() {
  return <UploadForm />;
}
