// ... (THREE require)
const { Pool } = require('pg'); // <-- DB와 통신하기 위한 라이브러리

// index.js (아래 코드를 모두 복사해서 붙여넣으세요)
// index.js (최상단)

// 이 키가 우리 서비스의 마스터 키입니다. 
// 나중에는 이 키를 '환경 변수'로 숨겨야 하지만, 지금은 테스트를 위해 여기에 둡니다.

// 1. 설치한 라이브러리들 불러오기
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const THREE = require('three');

const app = express();
const port = process.env.PORT || 3000;
// --- 5-C 단계: 환경 변수(Environment Variables)에서 비밀 값 읽기 ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// 1. Render 대시보드에서 'MASTER_API_KEY'라는 이름의 변수를 찾아 읽어옵니다.
const MASTER_API_KEY = process.env.MASTER_API_KEY; 

// 2. Render 대시보드에서 'VERCEL_APP_URL'라는 이름의 변수를 찾아 읽어옵니다.
const VERCEL_APP_URL = process.env.VERCEL_APP_URL; 

// 3. (안전장치) 만약 Render에 변수가 설정되지 않았으면, 서버를 즉시 중지시킵니다.
if (!MASTER_API_KEY || !VERCEL_APP_URL) {
  console.error(" [치명적 오류] : MASTER_API_KEY 또는 VERCEL_APP_URL 환경 변수가 설정되지 않았습니다!");
  console.error(" Render.com 대시보드의 'Environment' 탭을 확인하세요.");
  // process.exit(1); // 서버 강제 종료 (선택 사항)
} else {
  console.log("[환경 변수] 마스터 API 키 로드 성공 (***...)" + MASTER_API_KEY.slice(-4));
  console.log(`[환경 변수] 허용된 CORS 오리진: ${VERCEL_APP_URL}`);
}

// --- CORS 설정 (환경 변수 사용) ---
const corsOptions = {
  origin: VERCEL_APP_URL, // Render 대시보드에서 읽어온 Vercel 주소를 사용
  optionsSuccessStatus: 200 
};

// ... (이하는 app.use(cors(corsOptions)); 부터 동일합니다) ...

app.use(cors(corsOptions)); // 설정된 옵션으로 CORS 사용
app.use(express.json()); // 클라이언트가 보낸 JSON 데이터를 서버가 알아듣도록 설정

// Vercel에서 보낼 OPTIONS (preflight) 요청을 명시적으로 허용합니다.
app.options('/api/v1/create', cors(corsOptions));
app.options('/api/v1/verify', cors(corsOptions));
// ---

// 3. 임시 데이터 저장소 (서버가 켜져 있는 동안에만 정답을 기억함)
// 나중에는 이 부분을 Redis 같은 DB로 바꾸면 됩니다.
const sessionStore = {};

// 4. script.js에서 가져온 헬퍼 함수들 (Node.js 버전)
// 각도를 라디안으로 변환
function degToRad(degrees) {
  return degrees * (Math.PI / 180);
}

// 두 숫자 사이의 랜덤 값 생성
function randFloat(min, max) {
  return Math.random() * (max - min) + min;
}

// ... (app.options... 코드 끝)

// --- API 키 인증 미들웨어 (문지기) ---
// /api/v1/ 로 시작하는 모든 요청은 이 코드를 먼저 통과해야 합니다.
// 8. [필수] API 키 인증 '문지기' (DB 연동 버전)
// (async 함수로 변경되었습니다)
app.use('/api/v1', async (req, res, next) => {
  try {
    const apiKey = req.header('X-API-Key');
    const origin = req.header('Origin'); // 'https://...vercel.app' 또는 'http://...고객사이트.com'

    if (!apiKey) {
      return res.status(401).json({ message: "인증 실패: API 키가 누락되었습니다." });
    }

    // 1. DB에 API 키가 있는지 조회합니다.
    const query = "SELECT * FROM customers WHERE api_key = $1";
    const result = await pool.query(query, [apiKey]);

    // 2. DB에 키가 존재하지 않으면 (조회 결과가 0건) -> 차단!
    if (result.rows.length === 0) {
      console.warn(`[DB 인증 실패] 등록되지 않은 API 키: ${apiKey}`);
      return res.status(401).json({ message: "인증 실패: 유효하지 않은 API 키입니다." });
    }

    // 3. DB에 키가 존재합니다! (인증 성공)
    const customer = result.rows[0]; // 고객 정보 (api_key, allowed_domain)

    // 4. (보안 강화) 이 키가 허용된 도메인(Origin)에서 왔는지 확인합니다.
    // (주의: Supabase에 저장한 Vercel 주소와 Origin이 정확히 일치해야 합니다)
    if (customer.allowed_domain !== origin) {
      console.warn(`[DB 인증 실패] 허용되지 않은 도메인: ${origin} (API 키: ${apiKey})`);
      return res.status(401).json({ message: "인증 실패: 허용되지 않은 도메인입니다." });
    }

    // 5. 모든 인증 통과!
    // console.log(`[DB 인증 성공] API 키: ${apiKey.slice(-4)}...`);
    next(); // 다음 단계 (create, verify API)로 요청을 넘깁니다.

  } catch (error) {
    console.error("[DB 문지기 오류]", error);
    res.status(500).json({ message: "서버 내부 오류 (DB Auth)" });
  }
});


// 5. 캡챠 챌린지 생성 API (POST /api/v1/create)
app.post('/api/v1/create', (req, res) => {
// ... (이하 코드 동일) ...
  try {
    // 1. 고유한 세션 ID 생성
    const sessionId = uuidv4();

    // 2. script.js의 로직처럼 무작위 정답 각도 생성
    // (이 정답은 서버만 알고 있습니다.)
    const targetRotation = {
      x: degToRad(randFloat(-90, 90)),
      y: degToRad(randFloat(-90, 90)),
      z: degToRad(randFloat(-45, 45))
    };

    // 3. 임시 저장소에 [세션ID]와 [정답]을 저장
    sessionStore[sessionId] = targetRotation;

  // 4. 클라이언트(웹페이지)에게 "세션 ID"와 "정답 각도"를 전달
    // (참고: script.js가 이 정답 각도를 알아야 preview(미리보기) 캔버스를 그릴 수 있습니다.)
    res.status(201).json({ 
      session_id: sessionId,
      target_rotation: targetRotation // <-- 이 부분이 추가되었습니다!
    });

    console.log(`[${sessionId}] 챌린지 생성됨. (프론트엔드로 정답 전달 완료)`);

  } catch (error) {
    console.error("Create API 오류:", error);
    res.status(500).json({ message: "서버 내부 오류" });
  }
});

// 6. 캡챠 검증 API (POST /api/v1/verify)
app.post('/api/v1/verify', (req, res) => {
  try {
    // 1. 클라이언트가 보낸 데이터 받기
    const { session_id, user_rotation } = req.body;

    // 2. 세션 ID가 없거나, 저장소에 정답이 없으면 -> 실패
    if (!session_id || !sessionStore[session_id]) {
      return res.status(400).json({ message: "유효하지 않은 세션입니다." });
    }

    // 3. 저장소에서 정답 각도 꺼내기
    const targetRotation = sessionStore[session_id];

    // 4. script.js의 로직과 동일하게 오차 각도 계산
    // (Three.js의 Quaternion을 사용하여 두 각도의 차이를 계산)
    const userQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(user_rotation.x, user_rotation.y, user_rotation.z)
    );
    const targetQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(targetRotation.x, targetRotation.y, targetRotation.z)
    );

    const angleRadians = userQuaternion.angleTo(targetQuaternion);
    const angleDegrees = THREE.MathUtils.radToDeg(angleRadians); // 라디안 -> 각도

    // 5. 서버에서 허용 오차 설정
    const toleranceDegrees = 35; // 35도까지 봐줌 (나중에 조절 가능)

    // 6. 검증 (성공/실패)
    if (angleDegrees < toleranceDegrees) {
      // 성공!
      console.log(`[${session_id}] 검증 성공! (오차: ${angleDegrees.toFixed(1)}°)`);
      res.json({
        verified: true,
        error_angle: angleDegrees,
        tolerance: toleranceDegrees
      });
      // (보안) 검증에 성공했으니 임시 저장소에서 즉시 삭제
      delete sessionStore[session_id];

    } else {
      // 실패
      console.log(`[${session_id}] 검증 실패. (오차: ${angleDegrees.toFixed(1)}°)`);
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

// 7. 서버 실행
app.listen(port, () => {
  console.log(`🚀 Spatial-CAPTCHA API 서버가 http://localhost:${port} 에서 실행 중입니다.`);
  console.log("테스트용 API 엔드포인트:");
  console.log("  - 챌린지 생성: POST http://localhost:3000/api/v1/create");
  console.log("  - 챌린지 검증: POST http://localhost:3000/api/v1/verify");
});
