/** Which release this is - set when the site is built (see next.config.ts). */
export function ReleaseNumber({ label }: { label: string }) {
  return <p className="about-release">{label} {process.env.NEXT_PUBLIC_RELEASE}</p>;
}
