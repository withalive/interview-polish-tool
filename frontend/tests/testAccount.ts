// 테스트 전용 계정. 실제 계정이 아니며, 테스트가 AUTH_USERS 로 직접 주입한다.
export const TEST_EMAIL = 'tester@example.com';
export const TEST_PASSWORD = 'test-password';
export const TEST_AUTH_USERS = `${TEST_EMAIL}:${TEST_PASSWORD}:admin`;
