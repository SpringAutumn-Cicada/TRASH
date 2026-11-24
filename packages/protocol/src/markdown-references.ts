/** Resolve single-line Markdown reference links for the shared preview/validators.
 * Fences, inline code and images remain untouched. The caller still checks URLs.
 */
export function markdownReferences(text:string,referenceSource=text):{text:string;unresolved:string[]} {
 const definitions=new Map<string,string>();
 const key=(value:string)=>value.trim().replace(/\s+/g,' ').toLowerCase();
 const lines=text.split(/\r?\n/);let fence='';
 const outside=(line:string)=>{
  const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence='';return false;}
  return !fence;
 };
 const definition=/^\s{0,3}\[([^\]\n]+)\]:\s*(?:<([^>\n]+)>|(\S+?))(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*\)))?\s*$/;
 for(const line of referenceSource.split(/\r?\n/)){if(!outside(line))continue;const match=line.match(definition);if(match&&!definitions.has(key(match[1])))definitions.set(key(match[1]),match[2]??match[3]);}
 fence='';const unresolved=new Set<string>();
 const result=lines.map(line=>{
  if(!outside(line))return line;
  if(definition.test(line))return '';
  // Keep code spans and existing inline links intact, including their labels.
  return line.split(/(`+[^`]*`+|(?<!!)\[[^\]\n]+\]\([^\n]*?\))/g).map((part,index)=>{
   if(index%2)return part;
   return part.replace(/(?<![!\\])\[([^\]\n]+)\](?:\[([^\]\n]*)\])?/g,(whole:string,label:string,reference:string|undefined)=>{
    const id=key(reference===undefined||reference===''?label:reference),href=definitions.get(id);
    if(!href){if(reference!==undefined)unresolved.add(id);return whole;}
    return `[${label}](${href})`;
   });
  }).join('');
 }).join('\n');
 return {text:result,unresolved:[...unresolved]};
}
