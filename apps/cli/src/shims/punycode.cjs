const { domainToASCII, domainToUnicode } = require("node:url");

function decodeUcs2(value) {
  return Array.from(String(value), (char) => char.codePointAt(0));
}

function encodeUcs2(points) {
  return points.map((point) => String.fromCodePoint(point)).join("");
}

module.exports = {
  toASCII: domainToASCII,
  toUnicode: domainToUnicode,
  ucs2: {
    decode: decodeUcs2,
    encode: encodeUcs2,
  },
};
