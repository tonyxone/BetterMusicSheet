import { Home } from "../home";
import { pageMetadata } from "@/lib/i18n/metadata";

export const generateMetadata = () => pageMetadata("/");

export default function HomePage() {
  return <Home />;
}
