import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitTimeline } from "./split-timeline";

it("moves a numbered part's handle with pointer input and keeps a discarded gap", () => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  function Timeline() {
    const [ranges, setRanges] = useState([{ start: 0, end: 40 }, { start: 60, end: 100 }]);
    return <SplitTimeline duration={100} ranges={ranges} onChange={setRanges} disabled={false} />;
  }
  const { container } = render(<Timeline />);
  const track = container.querySelector('[aria-label="Video selection timeline"]')!;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 0, width: 100 } as DOMRect);
  const handle = screen.getByRole("slider", { name: "Part 1 end" });
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => true });
  fireEvent.pointerDown(handle, { clientX: 40 });
  fireEvent.pointerMove(handle, { clientX: 30 });
  fireEvent.pointerUp(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "30");
  expect(screen.getByRole("slider", { name: "Part 2 start" })).toHaveAttribute("aria-valuenow", "60");
  fireEvent.click(screen.getByRole("button", { name: "Delete part 1" }));
  expect(screen.getAllByRole("slider")).toHaveLength(2);
  expect(screen.getByRole("slider", { name: "Part 1 start" })).toHaveAttribute("aria-valuenow", "60");
  fireEvent.click(screen.getByRole("button", { name: "Delete part 1" }));
  expect(screen.queryAllByRole("slider")).toHaveLength(0);
  vi.unstubAllGlobals();
});
