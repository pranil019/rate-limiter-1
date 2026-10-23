pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                git branch: 'main',
                    url: 'https://github.com/pranil019/rate-limiter-1'
            }
        }

        stage('Build') {
            steps {
                echo 'Building application...'
                bat 'dir'
            }
        }

        stage('Test') {
            steps {
                echo 'Running tests...'
            }
        }
    }
}