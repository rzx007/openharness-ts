import { DuckDuckGoSearchProvider } from "./providers/duckduckgo-search.js";
import { HttpFetchProvider } from "./providers/http-fetch.js";
import { WebRuntime } from "./runtime.js";

export const defaultWebRuntime = new WebRuntime({
  searchProvider: new DuckDuckGoSearchProvider(),
  fetchProvider: new HttpFetchProvider(),
});
