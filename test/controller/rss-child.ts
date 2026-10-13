import { startTestRig } from "./fixture.ts";

const rig = await startTestRig();
process.stdout.write(`${process.memoryUsage().rss}\n`);
await rig.close();
