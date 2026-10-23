// The wordmark is user-supplied artwork: notes on a staff spelling out
// "Better Sheet Music".
export function Logo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/logo.png" alt="Better Sheet Music" width={220} height={65} />
  );
}
