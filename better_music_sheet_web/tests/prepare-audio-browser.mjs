// Creates a temporary browser harness using the actual instrument adapter.
import fs from 'node:fs';
import ts from 'typescript';
const dest = 'public/__audio-qa';
fs.mkdirSync(dest, {recursive:true});
for (const name of ['synth','basic-synth']) {
 const source = fs.readFileSync(`app/play/${name}.ts`, 'utf8');
 const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText
   .replaceAll('"./basic-synth"','"./basic-synth.mjs"').replaceAll('"smplr"','"./smplr.mjs"');
 fs.writeFileSync(`${dest}/${name}.mjs`,js);
}
fs.copyFileSync('node_modules/smplr/dist/index.mjs', `${dest}/smplr.mjs`);
fs.copyFileSync('tests/audio-browser.html', `${dest}/index.html`);
console.log('Open http://localhost:3000/__audio-qa/index.html; remove public/__audio-qa afterward.');
