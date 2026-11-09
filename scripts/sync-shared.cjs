const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
async function main() {
  const out = path.join(root, 'web/src/generated');
  fs.mkdirSync(out, {recursive:true});
  fs.rmSync(out, {recursive:true,force:true});
  await esbuild.build({ entryPoints:{core:path.join(root,'shared/core.js'),vocabulary:path.join(root,'data/vocabulary.js')}, bundle:true, splitting:true, format:'esm', platform:'browser', target:'es2020', outdir:out });
  for (const dir of ['shared','data']) {
    fs.cpSync(path.join(root,dir),path.join(root,'miniprogram',dir), {recursive:true,filter:(src)=>fs.statSync(src).isDirectory() || /\.js$/.test(src)});
  }
  fs.copyFileSync(path.join(root,'data/ECDICT-LICENSE.txt'),path.join(root,'miniprogram/data/ECDICT-LICENSE.txt'));
  console.log('已生成网页模块和微信共享学习核心。');
}
main().catch(error=>{ console.error(error); process.exit(1); });
