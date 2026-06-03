// qrcode-terminal 没有官方类型，给它一个最小声明（只用 generate）。
declare module "qrcode-terminal" {
  const qrcode: {
    generate(text: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
  };
  export default qrcode;
}
