/** Stable IDs stay independent of the readable knowledge_base directory layout. */
export const legacyKnowledgePath=/^(?:literature\/cards|wiki)\/[A-Za-z0-9_-]+\.md$/;
export const knowledgeBasePath=/^knowledge_base\/(?:(?:papers\/source_[A-Za-z0-9_-]+\/(?!.*--)(?:[a-z][a-z0-9_-]*\/){0,3}[a-z][a-z0-9_-]*|abstracts\/source_[A-Za-z0-9_-]+\/(?:interpretation|memory)|(?:topics|hypotheses|discoveries|summaries)\/wiki-[A-Za-z0-9_-]+|overview)\.md)$/;
export function knowledgeDocumentId(path:string):string|undefined{
 if(legacyKnowledgePath.test(path))return path.split('/').at(-1)!.slice(0,-3);
 const paper=path.match(/^knowledge_base\/papers\/(source_[A-Za-z0-9_-]+)\/(basic|key|detail|memory)\.md$/);
 if(paper)return paper[2]==='memory'?'wiki-'+paper[1]:'card-'+paper[1]+'-'+paper[2];
 const node=path.match(/^knowledge_base\/papers\/(source_[A-Za-z0-9_-]+)\/((?:[a-z][a-z0-9_-]*\/){0,3}[a-z][a-z0-9_-]*)\.md$/);
 if(node)return 'wiki-'+node[1]+'--'+node[2].replaceAll('/','--');
 const abstract=path.match(/^knowledge_base\/abstracts\/(source_[A-Za-z0-9_-]+)\/(interpretation|memory)\.md$/);
 if(abstract)return (abstract[2]==='memory'?'abstract-wiki-':'abstract-note-')+abstract[1];
 if(path==='knowledge_base/overview.md')return 'wiki-project-overview';
 if(knowledgeBasePath.test(path))return path.split('/').at(-1)!.slice(0,-3);
}
export function knowledgePath(path:string,level?:string):string{
 if(knowledgeBasePath.test(path))return path;
 const card=path.match(/^literature\/cards\/card-(source_[A-Za-z0-9_-]+)-(basic|key|detail)\.md$/);
 if(card)return 'knowledge_base/papers/'+card[1]+'/'+card[2]+'.md';
 const memory=path.match(/^wiki\/wiki-(source_[A-Za-z0-9_-]+)\.md$/);
 if(memory)return 'knowledge_base/papers/'+memory[1]+'/memory.md';
 if(path==='wiki/wiki-project-overview.md')return 'knowledge_base/overview.md';
 if(path.startsWith('wiki/')&&legacyKnowledgePath.test(path)){
  const category=level==='summary'?'summaries':level==='hypothesis'?'hypotheses':level==='discovery'?'discoveries':'topics';
  return 'knowledge_base/'+category+'/'+path.slice(5);
 }
 const abstract=path.match(/^abstract-library\/(notes|wiki)\/(source_[A-Za-z0-9_-]+)\.md$/);
 if(abstract)return 'knowledge_base/abstracts/'+abstract[2]+'/'+(abstract[1]==='wiki'?'memory':'interpretation')+'.md';
 return path;
}
export function legacyPath(path:string):string{
 const id=knowledgeDocumentId(path);
 if(!id)return path;
 if(path.includes('/abstracts/'))return 'abstract-library/'+(path.endsWith('/memory.md')?'wiki':'notes')+'/'+path.split('/')[2]+'.md';
 return (id.startsWith('card-')?'literature/cards/':'wiki/')+id+'.md';
}
