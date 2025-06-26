declare module '@cloudflare/workers-types' {
  export interface DurableObjectState { storage: any }
  export interface DurableObjectNamespace {
    idFromName(name: string): any
    get(id: any): any
  }
  export interface DurableObject {}
  export interface ExecutionContext {}
}
