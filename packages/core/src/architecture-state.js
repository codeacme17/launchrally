import { loadHostState, storeHostState } from "./host-state.js";

export function storeArchitectureState(state) {
  return storeHostState("architect", state);
}

export function loadArchitectureState(token) {
  return loadHostState("architect", token);
}
