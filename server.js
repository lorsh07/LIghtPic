const { createApp } = require('./src/app');
const config = require('./src/config');

const app = createApp();
app.listen(config.port, () => {
  console.log(`LightPic running at http://localhost:${config.port}`);
});
