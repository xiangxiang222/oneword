const fs = require('node:fs');
const path = require('node:path');
const releaseFile = path.join(__dirname, '.release-id');
const releaseId = fs.existsSync(releaseFile) ? fs.readFileSync(releaseFile, 'utf8').trim() : 'development';
module.exports = { apps: [{
  name: 'oneword',
  script: '/var/www/oneword/current/server/index.js',
  cwd: '/var/www/oneword/current',
  instances: 1,
  exec_mode: 'fork',
  max_memory_restart: '300M',
  env: { NODE_ENV:'production', PORT:'3795', BIND_HOST:'127.0.0.1', BASE_PATH:'/oneword', ONEWORD_RELEASE_ID:releaseId, ONEWORD_DB_PATH:'/var/www/oneword/data/oneword.sqlite' },
  time: true,
  kill_timeout: 11000
}] };
