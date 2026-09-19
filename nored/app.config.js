const fs = require('fs');
const path = require('path');

const appJson = require('./app.json');
const localPath = path.join(__dirname, 'app.local.json');

let local = {};
if (fs.existsSync(localPath)) {
  local = JSON.parse(fs.readFileSync(localPath, 'utf8'));
}

module.exports = {
  expo: {
    ...appJson.expo,
    ios: {
      ...appJson.expo.ios,
      ...(local.ios ?? {}),
    },
    android: {
      ...appJson.expo.android,
      ...(local.android ?? {}),
    },
    extra: {
      ...appJson.expo.extra,
      ...(local.extra ?? {}),
    },
  },
};
