import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { parseCsv, parseCsvWithHeader } from './lib/csv.ts';
import { buildStationRows, seedStations } from './seed-stations.ts';

const CSV = `"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","gps_code","iata_code","local_code","home_link","wikipedia_link","keywords"
3849,"KORD","large_airport","Chicago O'Hare International Airport",41.9786,-87.9048,672,"NA","US","US-IL","Chicago","yes","KORD","ORD","ORD",,,"CHI"
26464,"RKSI","large_airport","Incheon International Airport",37.46910095214844,126.45099639892578,23,"AS","KR","KR-28","Seoul","yes","RKSI","ICN",,,,"SEL"
2434,"EGLL","large_airport","London Heathrow Airport",51.4706,-0.461941,83,"EU","GB","GB-ENG","London","yes","EGLL","LHR",,,,"LON, Comma ""quoted"" name"
12345,"XX01","heliport","Nowhere Pad",0.1,0.1,10,"NA","US","US-XX","Nowhere","no","",,,,,
`;

describe('csv parser (scripts/lib)', () => {
  it('handles quoted fields, embedded commas, apostrophes and escaped quotes', () => {
    const rowsParsed = parseCsv(CSV);
    expect(rowsParsed.length).toBe(5); // header + 4
    const heathrow = rowsParsed[3]!;
    expect(heathrow[3]).toBe('London Heathrow Airport');
    expect(heathrow.at(-1)).toBe('LON, Comma "quoted" name');
    const ord = parseCsvWithHeader(CSV)[0]!;
    expect(ord['name']).toBe("Chicago O'Hare International Airport");
    expect(ord['iso_country']).toBe('US');
  });
});

describe('buildStationRows (§6.22)', () => {
  it('matches wanted ICAOs, converts elevation, derives tz from coordinates', () => {
    const { matched, unmatched } = buildStationRows(CSV, ['KORD', 'RKSI', 'EGLL', 'ZZZZ']);
    expect(unmatched).toEqual(['ZZZZ']);
    const byIcao = new Map(matched.map((m) => [m.icao, m]));
    expect(byIcao.get('KORD')).toMatchObject({ countryCode: 'US', tz: 'America/Chicago' });
    expect(byIcao.get('KORD')!.elevationM).toBeCloseTo(204.8, 1);
    expect(byIcao.get('RKSI')!.tz).toBe('Asia/Seoul');
    expect(byIcao.get('EGLL')!.tz).toBe('Europe/London');
  });
});

describe('seedStations against PGlite', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    // provisional rows the way discover-markets leaves them
    await db.exec(`
      insert into stations (icao, country_code, tz, source) values
        ('RKSI', 'KR', 'Etc/GMT-9', 'manual'),
        ('KORD', 'US', 'America/New_York', 'manual')  -- operator-corrected tz: must SURVIVE
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it('fills coordinates, upgrades provisional tz, never clobbers operator tz, reports unmatched', async () => {
    const scriptDb = {
      query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
        const pgParams = params.map((p) =>
          Array.isArray(p) ? `{${p.map((x) => `"${String(x)}"`).join(',')}}` : p,
        );
        return (await db.query<T>(sql, pgParams)).rows;
      },
    };
    const logs: string[] = [];
    const result = await seedStations({
      db: scriptDb,
      fetchCsv: async () => CSV,
      log: (m) => logs.push(m),
    });

    // RESEARCH_ICAOS adds KLGA/EGLC/LFPB which the tiny fixture lacks → unmatched, printed
    expect(result.unmatched).toEqual(['EGLC', 'KLGA', 'LFPB']);
    expect(logs.some((l) => l.includes('UNMATCHED'))).toBe(true);

    const rksi = (await rows<{ lat: string; tz: string; name: string; source: string }>(
      db,
      `select lat, tz, name, source from stations where icao = 'RKSI'`,
    ))[0]!;
    expect(Number(rksi.lat)).toBeCloseTo(37.469, 3);
    expect(rksi.tz).toBe('Asia/Seoul'); // provisional Etc/GMT-9 upgraded
    expect(rksi.name).toContain('Incheon');
    expect(rksi.source).toBe('ourairports');

    const kord = (await rows<{ lat: string; tz: string }>(
      db,
      `select lat, tz from stations where icao = 'KORD'`,
    ))[0]!;
    expect(Number(kord.lat)).toBeCloseTo(41.9786, 3);
    expect(kord.tz).toBe('America/New_York'); // operator override sticks

    const egll = (await rows<{ tz: string }>(db, `select tz from stations where icao = 'EGLL'`))[0]!;
    expect(egll.tz).toBe('Europe/London'); // brand-new row inserted
  });
});
