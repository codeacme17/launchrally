const CLACK_PACKAGE_PATH = "/node_modules/@clack/";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:util" && context.parentURL?.includes(CLACK_PACKAGE_PATH)) {
    return {
      shortCircuit: true,
      url: new URL("./clack-node20-util.js", import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
