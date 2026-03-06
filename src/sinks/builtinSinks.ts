import type { SinkDefinition } from "./sinkConfig";

export const builtinSinks: SinkDefinition[] = [
  {
    name: "fetch",
    type: "call",
    match: "fetch",
    urlArg: 0,
  },
  {
    name: "Request",
    type: "constructor",
    match: "Request",
    urlArg: 0,
  },
  {
    name: "XMLHttpRequest.open",
    type: "method",
    match: "XMLHttpRequest.open",
    methodArg: 0,
    urlArg: 1,
  },
  {
    name: "WebSocket",
    type: "constructor",
    match: "WebSocket",
    urlArg: 0,
  },
  {
    name: "EventSource",
    type: "constructor",
    match: "EventSource",
    urlArg: 0,
  },
  {
    name: "navigator.sendBeacon",
    type: "method",
    match: "navigator.sendBeacon",
    urlArg: 0,
    httpMethod: "POST",
  },
  {
    name: "axios",
    type: "call",
    match: "axios",
    urlArg: 0,
  },
  {
    name: "axios.get",
    type: "method",
    match: "axios.get",
    urlArg: 0,
    httpMethod: "GET",
  },
  {
    name: "axios.post",
    type: "method",
    match: "axios.post",
    urlArg: 0,
    httpMethod: "POST",
  },
  {
    name: "axios.put",
    type: "method",
    match: "axios.put",
    urlArg: 0,
    httpMethod: "PUT",
  },
  {
    name: "axios.delete",
    type: "method",
    match: "axios.delete",
    urlArg: 0,
    httpMethod: "DELETE",
  },
  {
    name: "axios.patch",
    type: "method",
    match: "axios.patch",
    urlArg: 0,
    httpMethod: "PATCH",
  },
];
