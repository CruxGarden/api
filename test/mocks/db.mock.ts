/**
 * Mock Database service for integration testing
 * Returns a mock Knex query builder
 */
export class MockDbService {
  private tables: Map<string, any[]> = new Map();

  constructor() {
    // Initialize common tables
    this.tables.set('accounts', []);
    this.tables.set('authors', []);
    this.tables.set('cruxes', []);
    this.tables.set('dimensions', []);
    this.tables.set('paths', []);
    this.tables.set('themes', []);
    this.tables.set('tags', []);
  }

  query(): any {
    // Return a chainable mock query builder
    return this.createMockQueryBuilder();
  }

  private createMockQueryBuilder() {
    const builder: any = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([]),
      first: jest.fn().mockResolvedValue(null),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      raw: jest.fn().mockResolvedValue(undefined),
    };
    return builder;
  }
  i;

  async paginate(): Promise<any[]> {
    return [];
  }

  async destroy(): Promise<void> {
    this.tables.clear();
  }

  // Test helper methods
  getTable(tableName: string): any[] {
    return this.tables.get(tableName) || [];
  }

  setTable(tableName: string, data: any[]): void {
    this.tables.set(tableName, data);
  }

  clearTable(tableName: string): void {
    this.tables.set(tableName, []);
  }

  clearAllTables(): void {
    this.tables.forEach((_, key) => {
      this.tables.set(key, []);
    });
  }
}
