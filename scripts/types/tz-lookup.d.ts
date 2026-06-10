declare module 'tz-lookup' {
  /** IANA zone for coordinates; throws RangeError on invalid input. */
  export default function tzlookup(lat: number, lon: number): string;
}
