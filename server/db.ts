import { eq, and, desc, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { 
  InsertUser, 
  users,
  companies,
  locations,
  departments,
  attendance,
  reports,
  subscriptions,
  InsertCompany,
  InsertLocation,
  InsertDepartment,
  InsertAttendance,
  InsertReport,
  InsertSubscription,
  Company,
  Location,
  Department,
  Attendance,
  Report,
  Subscription,
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

// ============================================================================
// USER OPERATIONS (Multi-Tenant Safe)
// ============================================================================

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'super_admin';
      updateSet.role = 'super_admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Get user by ID with company_id verification (TENANT-SAFE)
 * This ensures users can only access users within their company
 */
export async function getUserById(userId: number, companyId?: number) {
  const db = await getDb();
  if (!db) return undefined;

  const conditions = [eq(users.id, userId)];
  if (companyId !== undefined) {
    conditions.push(eq(users.companyId, companyId));
  }

  const result = await db.select().from(users).where(and(...conditions)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Get all users for a company (TENANT-SAFE)
 */
export async function getUsersByCompanyId(companyId: number) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(users).where(eq(users.companyId, companyId));
}

/**
 * Create a new user (TENANT-SAFE)
 */
export async function createUser(user: InsertUser) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (!user.companyId && user.role !== 'super_admin') {
    throw new Error("companyId is required for non-super-admin users");
  }

  const result = await db.insert(users).values(user);
  return result;
}

/**
 * Update user (TENANT-SAFE)
 */
export async function updateUser(userId: number, companyId: number, data: Partial<InsertUser>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Verify user belongs to company
  const user = await getUserById(userId, companyId);
  if (!user) {
    throw new Error("User not found or does not belong to this company");
  }

  return db.update(users).set(data).where(and(
    eq(users.id, userId),
    eq(users.companyId, companyId)
  ));
}

/**
 * Delete user (TENANT-SAFE)
 */
export async function deleteUser(userId: number, companyId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.delete(users).where(and(
    eq(users.id, userId),
    eq(users.companyId, companyId)
  ));
}

// ============================================================================
// COMPANY OPERATIONS
// ============================================================================

export async function createCompany(company: InsertCompany) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(companies).values(company);
  return result;
}

export async function getCompanyById(companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateCompany(companyId: number, data: Partial<InsertCompany>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.update(companies).set(data).where(eq(companies.id, companyId));
}

// ============================================================================
// SUBSCRIPTION OPERATIONS (TENANT-SAFE)
// ============================================================================

export async function createSubscription(subscription: InsertSubscription) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(subscriptions).values(subscription);
  return result;
}

export async function getSubscriptionByCompanyId(companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(subscriptions)
    .where(eq(subscriptions.companyId, companyId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function isSubscriptionActive(companyId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const company = await getCompanyById(companyId);
  if (!company) return false;

  // Check if subscription is active
  if (company.subscriptionStatus === "active") return true;
  
  // Check if still in trial
  if (company.subscriptionStatus === "trial" && company.trialEndsAt) {
    return new Date() < company.trialEndsAt;
  }

  return false;
}

export async function updateSubscription(subscriptionId: number, companyId: number, data: Partial<InsertSubscription>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Verify subscription belongs to company
  const subscription = await db.select().from(subscriptions)
    .where(and(
      eq(subscriptions.id, subscriptionId),
      eq(subscriptions.companyId, companyId)
    )).limit(1);

  if (subscription.length === 0) {
    throw new Error("Subscription not found or does not belong to this company");
  }

  return db.update(subscriptions).set(data).where(and(
    eq(subscriptions.id, subscriptionId),
    eq(subscriptions.companyId, companyId)
  ));
}

// ============================================================================
// LOCATION OPERATIONS (TENANT-SAFE)
// ============================================================================

export async function createLocation(location: InsertLocation) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.insert(locations).values(location);
}

export async function getLocationById(locationId: number, companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(locations).where(and(
    eq(locations.id, locationId),
    eq(locations.companyId, companyId)
  )).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getLocationsByCompanyId(companyId: number) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(locations).where(eq(locations.companyId, companyId));
}

export async function updateLocation(locationId: number, companyId: number, data: Partial<InsertLocation>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // Verify location belongs to company
  const location = await getLocationById(locationId, companyId);
  if (!location) {
    throw new Error("Location not found or does not belong to this company");
  }

  return db.update(locations).set(data).where(and(
    eq(locations.id, locationId),
    eq(locations.companyId, companyId)
  ));
}

export async function deleteLocation(locationId: number, companyId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.delete(locations).where(and(
    eq(locations.id, locationId),
    eq(locations.companyId, companyId)
  ));
}

// ============================================================================
// DEPARTMENT OPERATIONS (TENANT-SAFE)
// ============================================================================

export async function createDepartment(department: InsertDepartment) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.insert(departments).values(department);
}

export async function getDepartmentById(departmentId: number, companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(departments).where(and(
    eq(departments.id, departmentId),
    eq(departments.companyId, companyId)
  )).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getDepartmentsByCompanyId(companyId: number) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(departments).where(eq(departments.companyId, companyId));
}

export async function updateDepartment(departmentId: number, companyId: number, data: Partial<InsertDepartment>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const department = await getDepartmentById(departmentId, companyId);
  if (!department) {
    throw new Error("Department not found or does not belong to this company");
  }

  return db.update(departments).set(data).where(and(
    eq(departments.id, departmentId),
    eq(departments.companyId, companyId)
  ));
}

export async function deleteDepartment(departmentId: number, companyId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.delete(departments).where(and(
    eq(departments.id, departmentId),
    eq(departments.companyId, companyId)
  ));
}

// ============================================================================
// ATTENDANCE OPERATIONS (TENANT-SAFE)
// ============================================================================

export async function createAttendance(attendanceData: InsertAttendance) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(attendance).values(attendanceData);
  return result;
}

export async function getAttendanceById(attendanceId: number, companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(attendance).where(and(
    eq(attendance.id, attendanceId),
    eq(attendance.companyId, companyId)
  )).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAttendanceByUserAndDate(userId: number, companyId: number, date: Date) {
  const db = await getDb();
  if (!db) return undefined;

  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const result = await db.select().from(attendance).where(and(
    eq(attendance.userId, userId),
    eq(attendance.companyId, companyId),
  )).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getAttendanceByUserId(userId: number, companyId: number, limit: number = 30) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(attendance).where(and(
    eq(attendance.userId, userId),
    eq(attendance.companyId, companyId)
  )).orderBy(desc(attendance.clockInTime)).limit(limit);
}

export async function getAttendanceByCompanyId(companyId: number, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(attendance).where(
    eq(attendance.companyId, companyId)
  ).orderBy(desc(attendance.clockInTime)).limit(limit);
}

export async function updateAttendance(attendanceId: number, companyId: number, data: Partial<InsertAttendance>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const att = await getAttendanceById(attendanceId, companyId);
  if (!att) {
    throw new Error("Attendance record not found or does not belong to this company");
  }

  return db.update(attendance).set(data).where(and(
    eq(attendance.id, attendanceId),
    eq(attendance.companyId, companyId)
  ));
}

// ============================================================================
// REPORT OPERATIONS (TENANT-SAFE)
// ============================================================================

export async function createReport(report: InsertReport) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return db.insert(reports).values(report);
}

export async function getReportById(reportId: number, companyId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select().from(reports).where(and(
    eq(reports.id, reportId),
    eq(reports.companyId, companyId)
  )).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getReportsByUserId(userId: number, companyId: number, limit: number = 30) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(reports).where(and(
    eq(reports.userId, userId),
    eq(reports.companyId, companyId)
  )).orderBy(desc(reports.createdAt)).limit(limit);
}

export async function getReportsByCompanyId(companyId: number, limit: number = 100) {
  const db = await getDb();
  if (!db) return [];

  return db.select().from(reports).where(
    eq(reports.companyId, companyId)
  ).orderBy(desc(reports.createdAt)).limit(limit);
}

export async function updateReport(reportId: number, companyId: number, data: Partial<InsertReport>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const report = await getReportById(reportId, companyId);
  if (!report) {
    throw new Error("Report not found or does not belong to this company");
  }

  return db.update(reports).set(data).where(and(
    eq(reports.id, reportId),
    eq(reports.companyId, companyId)
  ));
}

// ============================================================================
// ANALYTICS QUERIES (TENANT-SAFE)
// ============================================================================

export async function getCompanyStats(companyId: number) {
  const db = await getDb();
  if (!db) return null;

  const staffCount = await db.select().from(users).where(and(
    eq(users.companyId, companyId),
    eq(users.role, 'staff')
  ));

  const todayAttendance = await db.select().from(attendance).where(
    eq(attendance.companyId, companyId)
  );

  const pendingReports = await db.select().from(reports).where(and(
    eq(reports.companyId, companyId),
    eq(reports.status, 'submitted')
  ));

  return {
    totalStaff: staffCount.length,
    todayAttendance: todayAttendance.length,
    pendingReports: pendingReports.length,
  };
}
