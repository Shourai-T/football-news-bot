declare module "*.sql?raw" {
  const source: string;
  export default source;
}

declare module "*.md?raw" {
  const source: string;
  export default source;
}

declare module "*.mjs?raw" {
  const source: string;
  export default source;
}
