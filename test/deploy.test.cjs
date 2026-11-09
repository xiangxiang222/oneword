const {test}=require('node:test');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const script=path.resolve(__dirname,'../scripts/patch-nginx.py');
const fixture=`server {\n    listen 80;\n    location /marathon/ {\n        proxy_pass http://127.0.0.1:3790;\n    }\n    location / {\n        proxy_pass http://127.0.0.1:3780;\n    }\n}\nserver {\n    listen 443 ssl;\n    location /marathon/ {\n        proxy_pass http://127.0.0.1:3790;\n    }\n    location / {\n        proxy_pass http://127.0.0.1:3780;\n    }\n}\n`;
function patch(text){return execFileSync('python3',['-c',`import runpy,sys; module=runpy.run_path(sys.argv[1]); sys.stdout.write(module['patch_config'](sys.stdin.read()))`,script],{input:text,encoding:'utf8',stdio:['pipe','pipe','pipe']})}
test('nginx mounts OneWord independently in HTTP and HTTPS without changing other upstreams',()=>{const out=patch(fixture);assert.equal(out.split('location /oneword/').length-1,2);assert.equal(out.split('proxy_pass http://127.0.0.1:3790;').length-1,2);assert.equal(out.split('proxy_pass http://127.0.0.1:3780;').length-1,2);assert.equal(out.replace(/    # OneWord:[\s\S]*?    location \/marathon\//g,'    location /marathon/'),fixture)});
test('nginx patch is idempotent and rejects partial configurations',()=>{const once=patch(fixture);assert.equal(patch(once),once);const partial=once.replace(/    # OneWord:[\s\S]*?(?=    location \/marathon\/)/,'');assert.throws(()=>patch(partial),/Partial OneWord/)});
test('nginx patch refuses unknown host layouts',()=>assert.throws(()=>patch('server { listen 443 ssl; }'),/Expected nginx locations/));
