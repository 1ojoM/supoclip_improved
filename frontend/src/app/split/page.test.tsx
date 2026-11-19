import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import VideoSplitPage from "./page";

vi.mock("@/components/app/app-shell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }) }));

afterEach(() => vi.unstubAllGlobals());

const split = { id: "a71caa2a-9d8e-4db3-a7e0-0667cb83bad6", source_url: "https://youtu.be/dQw4w9WgXcQ", title: "Recording",
  part_minutes: 90, status: "completed", progress: 100, error: null,
  parts: [{ id: "part-1", part_number: 1, start_seconds: 0, duration_seconds: 2700, video_path: "upload://part.mp4" }],
};

async function loadVideo() {
  fireEvent.change(screen.getByLabelText("YouTube, Twitch, or Kick video URL"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Load video" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Load video" }));
  return screen.findByLabelText("Number of parts");
}

it("loads duration, changes the number of parts, edits boundaries and submits only selected ranges", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/inspect")) return Response.json({ duration: 7200, title: "Recording" });
    if (init?.method === "POST") return Response.json({ id: split.id, status: "queued" }, { status: 202 });
    return Response.json({ capabilities: { stream_copy: true }, splits: [split] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<VideoSplitPage />);
  const count = await loadVideo();
  expect(count).toHaveValue("2");
  fireEvent.change(count, { target: { value: "3" } });
  expect(screen.getAllByRole("slider")).toHaveLength(6);
  fireEvent.keyDown(screen.getByRole("slider", { name: "Part 1 start" }), { key: "ArrowRight", shiftKey: true });
  expect(screen.getByRole("slider", { name: "Part 1 start" })).toHaveAttribute("aria-valuenow", "10");
  fireEvent.click(screen.getByRole("button", { name: "Split video" }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === "/api/video-splits" && init?.method === "POST")).toBe(true));
  const posted = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/video-splits" && init?.method === "POST")!;
  expect(JSON.parse(String(posted[1]?.body))).toEqual({ url: "https://youtu.be/dQw4w9WgXcQ", title: "Recording", source_duration: 7200,
    ranges: [{ start: 10, end: 2400 }, { start: 2400, end: 4800 }, { start: 4800, end: 7200 }],
  });
  expect(await screen.findByRole("link", { name: "Generate clips" })).toHaveAttribute("href", "/?splitPart=part-1");
});

it("cancels a running split and hides cleared results", async () => {
  let cancelled = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/cancel")) { cancelled = true; return Response.json({ status: "cancelled" }); }
    return Response.json({ capabilities: { stream_copy: true }, splits: [{ ...split, status: cancelled ? "cancelled" : "processing", parts: cancelled ? [] : split.parts }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<VideoSplitPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel and clear" }));
  await screen.findByText("Cancelled");
  expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(`/api/video-splits/${split.id}/cancel`, { method: "POST" });
});

it("explains a failed metadata request and allows another attempt", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ detail: "Metadata unavailable" }, { status: 422 }) : Response.json({ capabilities: { stream_copy: true }, splits: [] })));
  render(<VideoSplitPage />);
  fireEvent.change(screen.getByLabelText("YouTube, Twitch, or Kick video URL"), { target: { value: "https://youtu.be/dQw4w9WgXcQ" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Load video" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Load video" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Metadata unavailable");
  await waitFor(() => expect(screen.getByRole("button", { name: "Load video" })).toBeEnabled());
});


it("deletes an individual finished part from the results", async () => {
  let deleted = false;
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    return Response.json({ capabilities: { stream_copy: true }, splits: [{ ...split, parts: deleted ? [] : split.parts }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<VideoSplitPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete part 1" }));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Download" })).not.toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledWith("/api/video-splits/parts/part-1", { method: "DELETE" });
});
