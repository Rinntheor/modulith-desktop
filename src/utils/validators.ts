// src/utils/validators.ts
/**
 * 输入验证工具
 * 提供统一的输入验证和错误处理
 */

/**
 * 验证结果接口
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 创建验证结果
 */
export function createValidationResult(
  valid: boolean,
  errors: string[] = [],
  warnings: string[] = []
): ValidationResult {
  return { valid, errors, warnings };
}

/**
 * 验证字符串是否为空
 */
export function isNotEmpty(value: unknown, fieldName: string): ValidationResult {
  if (typeof value !== 'string' || value.trim() === '') {
    return createValidationResult(false, [`${fieldName} cannot be empty`]);
  }
  return createValidationResult(true);
}

/**
 * 验证字符串长度
 */
export function hasLengthInRange(
  value: string,
  min: number,
  max: number,
  fieldName: string
): ValidationResult {
  const length = value.length;
  if (length < min || length > max) {
    return createValidationResult(false, [
      `${fieldName} must be between ${min} and ${max} characters (got ${length})`,
    ]);
  }
  return createValidationResult(true);
}

/**
 * 验证模块 ID 格式
 */
export function isValidModuleId(moduleId: unknown): ValidationResult {
  if (typeof moduleId !== 'string') {
    return createValidationResult(false, ['Module ID must be a string']);
  }

  // 模块 ID 只能是字母、数字、连字符和下划线
  const moduleIdRegex = /^[a-zA-Z0-9_-]+$/;
  if (!moduleIdRegex.test(moduleId)) {
    return createValidationResult(false, [
      `Invalid module ID format: "${moduleId}". Only letters, numbers, hyphens, and underscores are allowed`,
    ]);
  }

  if (moduleId.length < 1 || moduleId.length > 64) {
    return createValidationResult(false, [
      `Module ID must be between 1 and 64 characters (got ${moduleId.length})`,
    ]);
  }

  return createValidationResult(true);
}

/**
 * 验证模块路径格式
 */
export function isValidModulePath(path: unknown): ValidationResult {
  if (typeof path !== 'string') {
    return createValidationResult(false, ['Module path must be a string']);
  }

  // 路径必须以 / 开头
  if (!path.startsWith('/')) {
    return createValidationResult(false, [`Module path must start with "/": "${path}"`]);
  }

  // 路径不能包含 ..
  if (path.includes('..')) {
    return createValidationResult(false, [`Module path cannot contain "..": "${path}"`]);
  }

  // 路径长度限制
  if (path.length > 256) {
    return createValidationResult(false, [
      `Module path must be less than 256 characters (got ${path.length})`,
    ]);
  }

  return createValidationResult(true);
}

/**
 * 验证索引范围
 */
export function isValidIndex(index: unknown, maxIndex: number, fieldName: string = 'Index'): ValidationResult {
  if (typeof index !== 'number' || !Number.isInteger(index)) {
    return createValidationResult(false, [`${fieldName} must be an integer`]);
  }

  if (index < 0 || index > maxIndex) {
    return createValidationResult(false, [
      `${fieldName} must be between 0 and ${maxIndex} (got ${index})`,
    ]);
  }

  return createValidationResult(true);
}

/**
 * 验证数组是否包含重复项
 */
export function hasNoDuplicates<T>(array: T[], fieldName: string = 'Array'): ValidationResult {
  const seen = new Set<T>();
  const duplicates: T[] = [];

  for (const item of array) {
    if (seen.has(item)) {
      duplicates.push(item);
    }
    seen.add(item);
  }

  if (duplicates.length > 0) {
    return createValidationResult(false, [
      `${fieldName} contains duplicates: ${JSON.stringify(duplicates)}`,
    ]);
  }

  return createValidationResult(true);
}

/**
 * 验证模块 ID 数组
 */
export function isValidModuleIdArray(moduleIds: unknown): ValidationResult {
  if (!Array.isArray(moduleIds)) {
    return createValidationResult(false, ['Module IDs must be an array']);
  }

  const errors: string[] = [];
  for (let i = 0; i < moduleIds.length; i++) {
    const result = isValidModuleId(moduleIds[i]);
    if (!result.valid) {
      errors.push(`Module ID at index ${i}: ${result.errors.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    return createValidationResult(false, errors);
  }

  return createValidationResult(true);
}

/**
 * 验证方向参数
 */
export function isValidDirection(direction: unknown): ValidationResult {
  if (direction !== 'up' && direction !== 'down') {
    return createValidationResult(false, [
      `Direction must be "up" or "down" (got "${direction}")`,
    ]);
  }
  return createValidationResult(true);
}

/**
 * 组合多个验证结果
 */
export function combineResults(...results: ValidationResult[]): ValidationResult {
  const allValid = results.every((r) => r.valid);
  const allErrors = results.flatMap((r) => r.errors);
  const allWarnings = results.flatMap((r) => r.warnings);

  return createValidationResult(allValid, allErrors, allWarnings);
}

/**
 * 断言验证结果，如果失败则抛出错误
 */
export function assertValid(result: ValidationResult, context: string = 'Validation'): void {
  if (!result.valid) {
    const message = `${context}: ${result.errors.join('; ')}`;
    console.error(message);
    throw new Error(message);
  }
}

/**
 * 安全地执行验证，返回验证结果而不是抛出错误
 */
export function validate<T>(
  value: T,
  validator: (value: T) => ValidationResult,
  context: string = 'Validation'
): ValidationResult {
  try {
    return validator(value);
  } catch (error) {
    return createValidationResult(false, [
      `Validation error in ${context}: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}
