/* global process, setInterval */
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("codex fixture 1\n");
} else {
  const snapshot=JSON.parse(readFileSync("input.json","utf8"));
  const prompt=readFileSync("prompt.txt","utf8");
  if(prompt.includes("FIXTURE_WAIT"))setInterval(()=>{},1000);
  else {
    const output=process.argv[process.argv.indexOf("-o")+1];
    if(prompt.includes("FIXTURE_BAD"))writeFileSync(output,"not json");
    else writeFileSync(output,JSON.stringify({source_id:snapshot.sources[0].source.source_id,title:"Generated card",method:"fixture method"}));
  }
}
