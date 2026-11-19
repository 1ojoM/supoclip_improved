import { GET, POST, DELETE } from "./route";
import { getServerSession } from "@/server/session";
import { fetchBackend } from "@/server/backend-api";

vi.mock("@/server/session", () => ({ getServerSession: vi.fn() }));
vi.mock("@/server/backend-api", () => ({
  fetchBackend: vi.fn(),
  createProxyResponse: (response: Response) => response,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getServerSession).mockResolvedValue({ user: { id: "owner" } } as never);
  vi.mocked(fetchBackend).mockResolvedValue(Response.json({ splits: [] }));
});

it("requires a session", async () => {
  vi.mocked(getServerSession).mockResolvedValue(null);
  const response = await GET(new Request("http://localhost/api/video-splits"), { params: Promise.resolve({}) });
  expect(response.status).toBe(401);
  expect(fetchBackend).not.toHaveBeenCalled();
});

it("forwards a split request with the authenticated owner", async () => {
  const body = JSON.stringify({ url: "https://youtu.be/dQw4w9WgXcQ", part_minutes: 45 });
  await POST(new Request("http://localhost/api/video-splits", { method: "POST", body }), { params: Promise.resolve({}) });
  expect(fetchBackend).toHaveBeenCalledWith("/video-splits", expect.objectContaining({ body, userId: "owner", method: "POST" }));
});

it("rejects traversal and unrelated backend paths", async () => {
  const response = await GET(new Request("http://localhost/api/video-splits/x"), { params: Promise.resolve({ path: ["..", "admin"] }) });
  expect(response.status).toBe(404);
  expect(fetchBackend).not.toHaveBeenCalled();
});


it("forwards metadata and cancellation posts without opening other backend routes", async () => {
  const id = "b31caa2a-9d8e-4db3-a7e0-0667cb83bad6";
  await POST(new Request("http://localhost/api/video-splits/inspect", { method: "POST", body: "{}" }), { params: Promise.resolve({ path: ["inspect"] }) });
  expect(fetchBackend).toHaveBeenCalledWith("/video-splits/inspect", expect.objectContaining({ method: "POST", userId: "owner" }));
  await POST(new Request(`http://localhost/api/video-splits/${id}/cancel`, { method: "POST" }), { params: Promise.resolve({ path: [id, "cancel"] }) });
  expect(fetchBackend).toHaveBeenCalledWith(`/video-splits/${id}/cancel`, expect.objectContaining({ method: "POST", userId: "owner" }));
});


it("allows deleting just the requested part", async () => {
  const id = "b31caa2a-9d8e-4db3-a7e0-0667cb83bad6";
  await DELETE(new Request(`http://localhost/api/video-splits/parts/${id}`, { method: "DELETE" }), { params: Promise.resolve({ path: ["parts", id] }) });
  expect(fetchBackend).toHaveBeenCalledWith(`/video-splits/parts/${id}`, expect.objectContaining({ method: "DELETE", userId: "owner" }));
});
