/* global process, setInterval */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
if (process.argv.includes("--version")) {
  process.stdout.write("codex fixture 1\n");
} else {
  const input=readFileSync(0,'utf8');
  const note=input.match(/把阅读笔记直接写到 ([^，]+)，/);
  if(note){writeFileSync(note[1],input.includes('FIXTURE_NO_NOTE')?'':'# Batch notes\n\nImage pages processed by fixture.');process.exit(0);}
  const snapshot=JSON.parse(readFileSync("input.json","utf8"));
  const prompt=readFileSync("prompt.txt","utf8");
  if(prompt.includes("FIXTURE_WAIT"))setInterval(()=>{},1000);
  else {
    const source=snapshot.sources[0].source.source_id;
    mkdirSync('output/literature/cards',{recursive:true});
    for(const type of ['detail','key']){
      const id=`card-${source}-${type}`;
      const text=prompt.includes('FIXTURE_BAD')?'invalid markdown':`---\nid: ${id}\nkind: literature-card\nsource_id: ${source}\ncard_type: ${type}\n---\n# Generated ${type}\n\nfixture method\n`;
      writeFileSync(`output/literature/cards/${id}.md`,text);
    }
  }
}
