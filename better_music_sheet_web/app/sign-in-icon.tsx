// User-supplied sign-in artwork, masked so it follows the shared navigation
// icon colour and hover treatment.

export function SignInIcon({ size = 34 }: { size?: number }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "block",
        width: size,
        height: size,
        backgroundColor: "currentColor",
        WebkitMask: "url('/sign-in-icon.png') center / contain no-repeat",
        mask: "url('/sign-in-icon.png') center / contain no-repeat",
      }}
    />
  );
}

export default SignInIcon;
