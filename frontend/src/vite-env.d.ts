/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 공개 HTTPS API 주소. /api까지 포함하며 비밀번호나 키를 넣지 않는다. */
  readonly VITE_API_BASE_URL?: string;
}
