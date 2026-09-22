export const LIBRARY_PAGE_SIZE = 10;

/** Where the paginated job list and the trailing demo entry fall, for one
 * page of the library. The demo is bundled content, not something the user
 * made, so it always sits after every real sheet (see
 * app/demo-sample-card.tsx) - which, once the list is paginated, means only
 * on the last page. Pulled out of app/library-view.tsx as a plain function
 * so the ordering rule has a test that doesn't need to render the component. */
export function paginateLibrary(jobCount: number, requestedPage: number, pageSize: number = LIBRARY_PAGE_SIZE) {
  const pageCount = jobCount > 0 ? Math.ceil(jobCount / pageSize) : 1;
  // Clamp rather than reset to 1: deleting the last item on the last page
  // should land on the new last page, not jump back to the start.
  const currentPage = Math.min(Math.max(1, requestedPage), pageCount);
  return {
    pageCount,
    currentPage,
    start: (currentPage - 1) * pageSize,
    end: currentPage * pageSize,
    /** Whether this page is where the demo entry belongs. */
    showDemoLast: currentPage === pageCount,
    /** Whether the library has no sheets of the user's own at all - the
     * demo then stands alone rather than sitting below an empty-state
     * message that would otherwise contradict it. */
    emptyLibrary: jobCount === 0,
  };
}
