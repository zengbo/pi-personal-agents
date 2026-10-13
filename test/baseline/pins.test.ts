import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NODE_ENGINE, PHASE } from "../../src/index.js";

describe("phase 0 baseline", () => {
  it("exports the phase marker", () => {
    expect(PHASE).toBe(0);
    expect(NODE_ENGINE).toBe(">=22.19.0");
  });

  it("pins direct dependencies without ranges", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      packageManager: string;
      engines: { node: string; npm: string };
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      overrides: Record<string, string>;
    };
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(pkg.engines.npm).toBe(">=11.0.0");
    expect(pkg.packageManager).toBe("npm@11.6.2");
    for (const section of [pkg.dependencies, pkg.devDependencies, pkg.overrides]) {
      for (const [name, version] of Object.entries(section)) {
        expect(version, name).not.toMatch(/[\^~*]/);
        expect(version, name).not.toMatch(/\s/);
      }
    }
    expect(pkg.dependencies["@earendil-works/pi-durable"]).toBe("1.1.0");
    expect(pkg.dependencies["@earendil-works/pi-ai"]).toBe("1.1.0");
    expect(pkg.dependencies["@earendil-works/chord"]).toBe("1.1.0");
    expect(pkg.overrides["@earendil-works/pi-durable"]).toBe("1.1.0");
    expect(pkg.overrides["@earendil-works/pi-ai"]).toBe("1.1.0");
    expect(pkg.overrides["@earendil-works/chord"]).toBe("1.1.0");
  });

  it("locks the installed earendil packages to 1.1.0", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {
      packages: Record<string, { version?: string }>;
    };
    for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/chord"]) {
      expect(lock.packages[`node_modules/${name}`]?.version).toBe("1.1.0");
    }
  });
});
