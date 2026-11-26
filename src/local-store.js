import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export class FileWriteStore {
  constructor(journal='.data/writes.json') {this.journal=journal;this.drafts=new Map();}
  async read() {try{return JSON.parse(await readFile(this.journal,'utf8'));}catch(e){if(e.code==='ENOENT') return {};throw e;}}
  async getAttempt(id) {return (await this.read())[id];}
  async putAttempt(id,attempt) {
    const log=await this.read();log[id]=attempt;
    await mkdir(path.dirname(this.journal),{recursive:true});
    await writeFile(this.journal+'.tmp',JSON.stringify(log),{mode:0o600});await rename(this.journal+'.tmp',this.journal);
  }
  async getDraft(id) {return this.drafts.get(id);}
  async putDraft(id,draft) {for(const [k,v] of this.drafts) if(v.expires<Date.now()) this.drafts.delete(k);this.drafts.set(id,draft);}
  async deleteDraft(id) {this.drafts.delete(id);}
}
