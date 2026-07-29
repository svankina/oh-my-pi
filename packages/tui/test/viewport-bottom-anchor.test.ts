import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Lines implements Component {
	constructor(public rows: string[]) {}

	render(): readonly string[] {
		return this.rows;
	}
}

describe("TUI viewport bottom anchor", () => {
	it("pads before the anchored suffix when the frame is shorter than the viewport", () => {
		const tui = new TUI(new VirtualTerminal(20, 8));
		const transcript = new Lines(["welcome"]);
		const footer = new Lines(["footer"]);
		const input = new Lines(["input"]);
		tui.addChild(transcript);
		tui.addChild(footer);
		tui.addChild(input);
		tui.setViewportBottomAnchor(footer);

		expect(tui.render(20)).toEqual(["welcome", "", "", "", "", "", "footer", "input"]);
	});

	it("removes padding as content grows past the viewport", () => {
		const tui = new TUI(new VirtualTerminal(20, 5));
		const transcript = new Lines(["welcome"]);
		const footer = new Lines(["footer"]);
		const input = new Lines(["input"]);
		tui.addChild(transcript);
		tui.addChild(footer);
		tui.addChild(input);
		tui.setViewportBottomAnchor(footer);
		expect(tui.render(20)).toEqual(["welcome", "", "", "footer", "input"]);

		transcript.rows = ["one", "two", "three", "four"];
		expect(tui.render(20)).toEqual(["one", "two", "three", "four", "footer", "input"]);
	});

	it("paints anchored chrome on the bottom rows of a real terminal viewport", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const transcript = new Lines(["welcome"]);
		const footer = new Lines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(footer);
		tui.addChild(new Lines(["input"]));
		tui.setViewportBottomAnchor(footer);

		try {
			tui.start();
			await scheduler.drain(terminal);
			expect(terminal.getViewport().map(row => row.trimEnd())).toEqual([
				"welcome",
				"",
				"",
				"",
				"",
				"",
				"footer",
				"input",
			]);
		} finally {
			tui.stop();
			await terminal.flush();
		}
	});
});
