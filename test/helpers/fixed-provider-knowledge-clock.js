const NativeDate = Date;
const fixedNow = NativeDate.parse("2026-08-13T00:00:00.000Z");

globalThis.Date = new Proxy(NativeDate, {
  apply(target, thisArgument, arguments_) {
    if (arguments_.length === 0) return new target(fixedNow).toString();
    return Reflect.apply(target, thisArgument, arguments_);
  },
  construct(target, arguments_, newTarget) {
    const actualArguments = arguments_.length === 0 ? [fixedNow] : arguments_;
    return Reflect.construct(target, actualArguments, newTarget);
  },
  get(target, property, receiver) {
    if (property === "now") return () => fixedNow;
    return Reflect.get(target, property, receiver);
  },
});
