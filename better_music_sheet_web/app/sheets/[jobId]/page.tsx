import { JobStatus } from "./job-status";

export default async function SheetPage({ params }: PageProps<"/sheets/[jobId]">) {
  const { jobId } = await params;
  return <JobStatus jobId={jobId} />;
}
