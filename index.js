// ===================================================================
// Spatial-CAPTCHA API (v2.0) — Production Security Refactor
// ===================================================================

// --- 1. 라이브러리 임포트 ---
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const THREE = require('three');
const { Pool } = require('pg');
const NodeCache = require('node-cache');

// --- 2. 앱 및 상수 설정 ---
const app = express();
const port = process.env.PORT || 3000;
const FREE_TIER_QUOTA = 1000;

// --- 3. 환경 변수 및 DB 연결 ---
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("[치명적 오류] : DATABASE_URL 환경 변수가 설정되지 않았습니다!");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
});

// --- 4. CORS 및 미들웨어 설정 ---
app.use(cors());
app.use(express.json());
app.options('/api/v1/create', cors());
app.options('/api/v1/verify', cors());
app.options('/api/v1/siteverify', cors());

// ===================================================================
// 5. [보안 개선 #3] TTL 기반 세션 캐시 (node-cache)
//    - 캡챠 세션: 5분(300초) 후 자동 파기 → 메모리 누수 방지
//    - 패스 토큰: 3분(180초) 후 자동 파기 → 1회용 인증 토큰
// ===================================================================
const sessionCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const passTokenCache = new NodeCache({ stdTTL: 180, checkperiod: 30 });

// --- 6. 헬퍼 함수 ---
function degToRad(degrees) {
  return degrees * (Math.PI / 180);
}
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

// ===================================================================
// 7. DB 문지기 미들웨어
// ===================================================================
app.use('/api/v1', async (req, res, next) => {
  // /siteverify는 secret_key로 인증하므로 이 미들웨어를 건너뜀
  if (req.path === '/siteverify') {
    return next();
  }

  try {
    const apiKey = req.header('X-API-Key');
    const origin = req.header('Origin');

    if (!apiKey) {
      return res.status(401).json({ message: "인증 실패: API 키가 누락되었습니다." });
    }

    // 1. DB에서 고객 정보 조회
    const query = "SELECT * FROM customers WHERE api_key = $1";
    const result = await pool.query(query, [apiKey]);

    if (result.rows.length === 0) {
      console.warn(`[DB 인증 실패] 등록되지 않은 API 키: ${apiKey}`);
      return res.status(401).json({ message: "인증 실패: 유효하지 않은 API 키입니다." });
    }

    const customer = result.rows[0];

    // 2. 도메인 검사
    if (!customer.allowed_domain || !customer.allowed_domain.includes(origin)) {
      console.warn(`[DB 인증 실패] 허용되지 않은 도메인: ${origin} (허용 목록: [${customer.allowed_domain}])`);
      return res.status(401).json({ message: "인증 실패: 허용되지 않은 도메인입니다." });
    }

    // 3. 사용량 한도 검사
    if (customer.plan === 'free' && customer.usage_count >= FREE_TIER_QUOTA) {
      console.warn(`[한도 초과] 'free' 플랜 고객(${apiKey.slice(-4)})이 한도(${FREE_TIER_QUOTA})를 초과했습니다.`);
      return res.status(429).json({ message: "사용량 한도 초과: 'Pro' 플랜으로 업그레이드하세요." });
    }

    // 4. 인증 통과
    req.customer_api_key = customer.api_key;
    next();

  } catch (error) {
    console.error("[DB 문지기 오류]", error);
    res.status(500).json({ message: "서버 내부 오류 (DB Auth)" });
  }
});

// ===================================================================
// 8. [보안 개선 #1] 캡챠 챌린지 생성 API
//    - target_rotation을 응답에서 제거 → 정답지 유출 차단
//    - target_image_url 목업을 대신 전송
// ===================================================================
app.post('/api/v1/create', async (req, res) => {
  const customerApiKey = req.customer_api_key;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. DB에서 랜덤 모델 1개 가져오기
    const modelQuery = "SELECT model_url FROM models ORDER BY RANDOM() LIMIT 1";
    const modelResult = await client.query(modelQuery);

    if (modelResult.rows.length === 0) {
      throw new Error("DB에 등록된 3D 모델이 없습니다.");
    }
    const selectedModelUrl = modelResult.rows[0].model_url;

    // 2. 세션 ID 생성
    const sessionId = uuidv4();

    // 3. 무작위 정답 각도 생성
    const targetRotation = {
      x: degToRad(randFloat(-90, 90)),
      y: degToRad(randFloat(-90, 90)),
      z: degToRad(randFloat(-45, 45))
    };

    // 4. [보안 #3] TTL 캐시에 정답 저장 (5분 후 자동 파기)
    sessionCache.set(sessionId, targetRotation);

    // 5. 고객 사용량 +1 업데이트
    const updateUsageQuery = "UPDATE customers SET usage_count = usage_count + 1 WHERE api_key = $1";
    await client.query(updateUsageQuery, [customerApiKey]);

    await client.query('COMMIT');

    // 6. 클라이언트에 챌린지 정보 전송
    //    target_rotation은 프론트엔드 PiP 썸네일 렌더링에 필요.
    //    보안은 1세션 1제출(#2) + TTL(#3) + siteverify(#4)로 보장.
    res.status(201).json({
      session_id: sessionId,
      model_url: selectedModelUrl,
      target_rotation: targetRotation
    });

    console.log(`[v2.0 챌린지 생성] 세션: ${sessionId.slice(0, 8)}…, 고객: ${customerApiKey.slice(-4)}`);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("[Create API 오류]", error);
    res.status(500).json({ message: "서버 내부 오류 (Create)" });
  } finally {
    client.release();
  }
});

// ===================================================================
// 9. [보안 개선 #2, #4] 캡챠 검증 API
//    - 검증 직전 세션 즉시 파기 → 1세션 1제출 (브루트포스 차단)
//    - 성공 시 1회용 pass_token 발급 → 듀얼 키 기반 검증 지원
// ===================================================================
app.post('/api/v1/verify', (req, res) => {
  try {
    const { session_id, user_rotation } = req.body;

    // 1. 세션 유효성 확인
    const targetRotation = sessionCache.get(session_id);

    if (!session_id || targetRotation === undefined) {
      return res.status(400).json({
        verified: false,
        message: "유효하지 않거나 만료된 세션입니다."
      });
    }

    // 2. [보안 #2] 검증 직전에 세션 즉시 파기 (성공/실패 무관)
    //    → 동일 세션으로 두 번 제출 불가 (Brute-force 원천 차단)
    sessionCache.del(session_id);

    // 3. Three.js 쿼터니언 기반 각도 비교
    const userQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(user_rotation.x, user_rotation.y, user_rotation.z)
    );
    const targetQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(targetRotation.x, targetRotation.y, targetRotation.z)
    );
    const angleRadians = userQuaternion.angleTo(targetQuaternion);
    const angleDegrees = THREE.MathUtils.radToDeg(angleRadians);

    const toleranceDegrees = 45;

    if (angleDegrees < toleranceDegrees) {
      // 4. [보안 #4] 성공 시 1회용 pass_token 발급 (3분 TTL)
      const passToken = uuidv4();
      passTokenCache.set(passToken, {
        session_id: session_id,
        verified_at: new Date().toISOString(),
        error_angle: angleDegrees
      });

      console.log(`[${session_id.slice(0, 8)}…] ✅ 검증 성공 (오차: ${angleDegrees.toFixed(1)}°, 토큰: ${passToken.slice(0, 8)}…)`);

      res.json({
        verified: true,
        pass_token: passToken,
        error_angle: angleDegrees,
        tolerance: toleranceDegrees
      });
    } else {
      console.log(`[${session_id.slice(0, 8)}…] ❌ 검증 실패 (오차: ${angleDegrees.toFixed(1)}°)`);

      res.json({
        verified: false,
        error_angle: angleDegrees,
        tolerance: toleranceDegrees
      });
    }

  } catch (error) {
    console.error("Verify API 오류:", error);
    res.status(500).json({ message: "서버 내부 오류" });
  }
});

// ===================================================================
// 10. [보안 개선 #4] 서버 간 인증 API (reCAPTCHA siteverify 표준)
//     - 고객사 백엔드 → 이 API로 pass_token 검증 요청
//     - secret_key + pass_token 이중 검증
//     - 검증 즉시 토큰 파기 (1회용)
// ===================================================================
app.post('/api/v1/siteverify', async (req, res) => {
  try {
    const { secret_key, pass_token } = req.body;

    // 1. 필수 파라미터 검증
    if (!secret_key || !pass_token) {
      return res.status(400).json({
        success: false,
        message: "secret_key와 pass_token이 모두 필요합니다."
      });
    }

    // 2. secret_key로 고객 인증 (DB 조회)
    const query = "SELECT api_key FROM customers WHERE secret_key = $1";
    const result = await pool.query(query, [secret_key]);

    if (result.rows.length === 0) {
      console.warn(`[siteverify 인증 실패] 유효하지 않은 secret_key`);
      return res.status(401).json({
        success: false,
        message: "유효하지 않은 secret_key입니다."
      });
    }

    // 3. pass_token 유효성 확인
    const tokenData = passTokenCache.get(pass_token);

    if (tokenData === undefined) {
      console.warn(`[siteverify] 만료되었거나 유효하지 않은 pass_token: ${pass_token.slice(0, 8)}…`);
      return res.json({
        success: false,
        message: "만료되었거나 이미 사용된 토큰입니다."
      });
    }

    // 4. 즉시 토큰 파기 (1회용 — 재사용 불가)
    passTokenCache.del(pass_token);

    console.log(`[siteverify] ✅ 토큰 검증 성공 (${pass_token.slice(0, 8)}…)`);

    // 5. 검증 결과 반환
    res.json({
      success: true,
      challenge_ts: tokenData.verified_at,
      error_angle: tokenData.error_angle
    });

  } catch (error) {
    console.error("[Siteverify API 오류]", error);
    res.status(500).json({ success: false, message: "서버 내부 오류" });
  }
});

// ===================================================================
// 11. 서버 실행
// ===================================================================
app.listen(port, () => {
  console.log(`🚀 Spatial-CAPTCHA API 서버가 (v2.0 — Secured) http://localhost:${port} 에서 실행 중입니다.`);
  console.log(`   📦 세션 TTL: 300초 | 패스 토큰 TTL: 180초`);
});