// A reference to a private asset host, which no built-in plugin knows about. The
// path is served by this same fixture, under a prefix that no plugin's patterns
// cover, so the custom-plugin example has something real to find.
export const vendor = 'vendor';
const assets = '/private-assets/bundles/vendor-core.js';
export { assets };
