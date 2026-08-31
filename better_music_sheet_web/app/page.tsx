import { UploadForm } from "./upload-form";

// Public landing page (see proxy.ts) - UploadForm itself prompts sign-in
// when a signed-out visitor tries to actually use it.
export default function Home() {
  return <UploadForm />;
}
