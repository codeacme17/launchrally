const deny = () => {
  throw new Error("coverage matrix attempted network access without permission");
};

const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

dns.lookup = deny;
dns.promises.lookup = async () => deny();
net.connect = deny;
net.createConnection = deny;
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
global.fetch = deny;
